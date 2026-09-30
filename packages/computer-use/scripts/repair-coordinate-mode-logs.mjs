/**
 * One-shot repair for stored session logs poisoned by the
 * `computer-use/coordinate-mode` stamp: that out-of-repo event type is absent
 * from the official `KNOWN_SESSION_EVENT_TYPES` catalog and was written without
 * the envelope's `ignorable` marker, so the persistence read path refuses the
 * whole log ("unknown to this harness and not marked ignorable").
 *
 * The repair adds `"ignorable": true` to those events in place — the payload is
 * kept (projections and `loggedCoordinateMode` read raw events either way) and
 * readers that know the type (fork harness) fold it as before. V3 logs will
 * later rename it to `plugin:computer-use/coordinate-mode` on migration, which
 * the plugin's reader also accepts.
 *
 * Per file: decode every zstd frame, patch matching JSONL lines, recompress
 * only the changed frames (checksummed, same as the writer), read back and
 * verify, then atomically replace. Touched files are mirrored into a backup
 * directory first. Recently modified (active) sessions are skipped; the script
 * is idempotent and can be re-run to pick them up.
 *
 * Usage: node repair-coordinate-mode-logs.mjs [--dry-run] [--sessions-dir DIR]
 *        [--skip-recent-min N]
 * @module @dsh-orb/computer-use/scripts/repair-coordinate-mode-logs
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ZSTD_MAGIC = 0xfd2fb528
const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const PATCHABLE_TYPES = new Set(['computer-use/coordinate-mode', 'plugin:computer-use/coordinate-mode'])
const LOG_FILE_RE = /^session\.v[34]\.jsonl\.zstd$/

/**
 * Locate structurally complete zstd frames without decompressing them
 * (same shape as the persistence backend's frame scanner).
 * @param buffer - complete bytes of a session artifact.
 * @returns complete frame ranges and the start of an incomplete trailing frame, if any.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${String(offset)}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${String(offset - 1)}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${String(offset - 3)}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode the complete frames of a multi-frame session artifact to JSONL text.
 * @param buffer - artifact bytes.
 * @returns concatenated complete-frame plaintexts.
 */
export function decodeCompleteFrames(buffer) {
  const { frames } = scanZstdFrames(buffer)
  return frames.map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')).join('')
}

/**
 * Decode a whole multi-frame session artifact to JSONL text, refusing a torn tail.
 * @param buffer - artifact bytes.
 * @returns concatenated frame plaintexts.
 */
export function decodeLogBuffer(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (tornStart !== undefined) {
    throw new Error(`incomplete trailing zstd frame at byte ${String(tornStart)}`)
  }
  return frames.map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')).join('')
}

/**
 * Add the `ignorable` marker to one JSONL line when it carries a
 * coordinate-mode event without it.
 * @param line - one JSONL line.
 * @returns the (possibly rewritten) line and whether it changed.
 */
export function patchEventLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return { line, patched: false }
  }
  if (event === null || typeof event !== 'object') return { line, patched: false }
  if (!PATCHABLE_TYPES.has(event.type)) return { line, patched: false }
  if (event.ignorable === true) return { line, patched: false }
  return { line: JSON.stringify({ ...event, ignorable: true }), patched: true }
}

/**
 * Patch every coordinate-mode event in JSONL text, preserving line endings.
 * @param text - artifact plaintext.
 * @returns rewritten text and the number of patched events.
 */
export function patchLogText(text) {
  let count = 0
  const lines = text.split('\n').map(line => {
    const cr = line.endsWith('\r') ? '\r' : ''
    const body = cr === '' ? line : line.slice(0, -1)
    const result = patchEventLine(body)
    if (result.patched) count += 1
    return result.line + cr
  })
  return { text: lines.join('\n'), count }
}

/**
 * Repair one artifact: patch matching frames in place, leave all other frame
 * bytes untouched, and preserve a torn trailing frame verbatim.
 * @param buffer - artifact bytes.
 * @returns rewritten bytes, patched event count, and whether anything changed.
 */
export function repairLogBuffer(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  let count = 0
  const parts = []
  for (const frame of frames) {
    const raw = buffer.subarray(frame.start, frame.end)
    const text = zstdDecompressSync(raw).toString('utf8')
    const result = patchLogText(text)
    if (result.count === 0) {
      parts.push(raw)
    } else {
      count += result.count
      parts.push(zstdCompressSync(Buffer.from(result.text, 'utf8'), ZSTD_CHECKSUM_OPTIONS))
    }
  }
  if (tornStart !== undefined) parts.push(buffer.subarray(tornStart))
  return { buffer: Buffer.concat(parts), count, changed: count > 0 }
}

/**
 * Collect candidate log files under the sessions root.
 * @param sessionsDir - `~/.dsh/sessions` (or a subtree).
 * @returns sorted artifact paths named session.v3/v4.jsonl.zstd.
 */
export function findLogFiles(sessionsDir) {
  const found = []
  const walk = dir => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.backup-')) continue
        walk(full)
      } else if (LOG_FILE_RE.test(entry.name)) {
        found.push(full)
      }
    }
  }
  walk(sessionsDir)
  return found.sort()
}

/**
 * Count JSONL event lines in decoded plaintext.
 * @param text - artifact plaintext.
 * @returns non-empty line count.
 */
export function countLines(text) {
  return text.split('\n').filter(line => line.trim() !== '').length
}

/**
 * Repair every artifact in a sessions tree, backing up touched files first.
 * @param options - sessionsDir, dryRun, skipRecentMin, log (report sink).
 * @returns summary counts and per-file records.
 */
export function repairSessions(options) {
  const { sessionsDir, dryRun = false, skipRecentMin = 5, log = () => {} } = options
  const now = Date.now()
  const skipWindowMs = skipRecentMin * 60 * 1000
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(sessionsDir, `.backup-coordinate-mode-${stamp}`)
  const manifest = []
  const summary = { scanned: 0, patched: 0, unchanged: 0, skippedRecent: 0, failed: 0 }

  for (const file of findLogFiles(sessionsDir)) {
    summary.scanned += 1
    const relative = path.relative(sessionsDir, file)
    let stat
    try {
      stat = fs.statSync(file)
    } catch (error) {
      summary.failed += 1
      manifest.push({ file: relative, status: 'failed', error: String(error) })
      log(`FAIL  ${relative}: ${String(error)}`)
      continue
    }
    if (skipWindowMs > 0 && now - stat.mtimeMs < skipWindowMs) {
      summary.skippedRecent += 1
      manifest.push({ file: relative, status: 'skipped-recent' })
      log(`SKIP  ${relative} (modified ${String(Math.round((now - stat.mtimeMs) / 1000))}s ago)`)
      continue
    }
    let result
    try {
      const buffer = fs.readFileSync(file)
      result = repairLogBuffer(buffer)
      if (!result.changed) {
        summary.unchanged += 1
        manifest.push({ file: relative, status: 'unchanged' })
        continue
      }
      const before = decodeCompleteFrames(buffer)
      const after = decodeCompleteFrames(result.buffer)
      if (patchLogText(after).count !== 0) throw new Error('read-back still contains unmarked events')
      if (countLines(after) !== countLines(before)) throw new Error('read-back changed the event-line count')
      const expected = patchLogText(before).text
      if (after !== expected) throw new Error('read-back differs from the patched plaintext')
    } catch (error) {
      summary.failed += 1
      manifest.push({ file: relative, status: 'failed', error: String(error) })
      log(`FAIL  ${relative}: ${String(error)}`)
      continue
    }
    if (dryRun) {
      summary.patched += 1
      manifest.push({ file: relative, status: 'would-patch', events: result.count })
      log(`FIX   ${relative} (${String(result.count)} events, dry-run)`)
      continue
    }
    try {
      const backupPath = path.join(backupDir, relative)
      fs.mkdirSync(path.dirname(backupPath), { recursive: true })
      fs.copyFileSync(file, backupPath)
      const tmp = `${file}.repair-tmp`
      fs.writeFileSync(tmp, result.buffer)
      if (decodeCompleteFrames(fs.readFileSync(tmp)) !== decodeCompleteFrames(result.buffer)) {
        throw new Error('temporary file read-back mismatch')
      }
      fs.renameSync(tmp, file)
      summary.patched += 1
      manifest.push({ file: relative, status: 'patched', events: result.count })
      log(`FIX   ${relative} (${String(result.count)} events)`)
    } catch (error) {
      summary.failed += 1
      manifest.push({ file: relative, status: 'failed', error: String(error) })
      log(`FAIL  ${relative}: ${String(error)}`)
      try {
        fs.rmSync(`${file}.repair-tmp`, { force: true })
      } catch { /* best effort */ }
    }
  }

  if (!dryRun && manifest.some(entry => entry.status === 'patched')) {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify({ createdAt: new Date(now).toISOString(), sessionsDir, summary, manifest }, null, 2),
    )
    log(`backup + manifest: ${backupDir}`)
  }
  return { summary, manifest, backupDir: dryRun ? undefined : backupDir }
}

function parseArgs(argv) {
  const options = {
    sessionsDir: path.join(os.homedir(), '.dsh', 'sessions'),
    dryRun: false,
    skipRecentMin: 5,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--sessions-dir') options.sessionsDir = argv[++index] ?? options.sessionsDir
    else if (arg === '--skip-recent-min') options.skipRecentMin = Number(argv[++index] ?? '5')
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node repair-coordinate-mode-logs.mjs [--dry-run] [--sessions-dir DIR] [--skip-recent-min N]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return options
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  console.log(`sessions dir: ${options.sessionsDir}${options.dryRun ? ' (dry-run)' : ''}`)
  const { summary } = repairSessions({ ...options, log: line => console.log(line) })
  console.log(
    `done: scanned ${String(summary.scanned)}, patched ${String(summary.patched)}, `
    + `unchanged ${String(summary.unchanged)}, skipped(recent) ${String(summary.skippedRecent)}, failed ${String(summary.failed)}`,
  )
  if (summary.failed > 0) process.exitCode = 1
}
