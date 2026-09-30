import { constants, zstdCompressSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countLines,
  decodeCompleteFrames,
  decodeLogBuffer,
  findLogFiles,
  patchEventLine,
  patchLogText,
  repairLogBuffer,
  repairSessions,
  scanZstdFrames,
} from '../scripts/repair-coordinate-mode-logs.mjs'

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function frame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM)
}

function artifact(root: string, relative: string, frames: readonly Buffer[]): string {
  const file = join(root, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, Buffer.concat(frames))
  return file
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-orb-repair-'))
  roots.push(root)
  return root
}

describe('coordinate-mode log repair primitives', () => {
  it('scans concatenated frames and merges multi-line plaintext', () => {
    const buffer = Buffer.concat([
      frame('{"type":"session","version":4}\n'),
      frame('{"type":"model/selection","seq":1,"time":1,"data":{}}\n'),
    ])
    const { frames, tornStart } = scanZstdFrames(buffer)
    expect(frames.length).toBe(2)
    expect(tornStart).toBeUndefined()
    expect(decodeLogBuffer(buffer)).toContain('"version":4')
    expect(decodeLogBuffer(buffer)).toContain('"seq":1')
    expect(countLines(decodeLogBuffer(buffer))).toBe(2)
  })

  it('detects a torn trailing frame and preserves it byte-for-byte on repair', () => {
    const whole = Buffer.concat([frame('{"type":"session","version":4}\n'), frame('{"seq":1}\n')])
    const torn = whole.subarray(0, whole.length - 5)
    expect(scanZstdFrames(torn).tornStart).toBeDefined()
    const repaired = repairLogBuffer(torn)
    expect(repaired.changed).toBe(false)
    expect(repaired.buffer.equals(torn)).toBe(true)
    expect(() => decodeLogBuffer(torn)).toThrow(/incomplete trailing zstd frame/)
  })

  it('patches only unmarked coordinate-mode events and is idempotent', () => {
    const event = '{"type":"computer-use/coordinate-mode","seq":6,"time":2,"data":{"mode":"pixel"}}'
    expect(patchEventLine(event)).toEqual({
      line: '{"type":"computer-use/coordinate-mode","seq":6,"time":2,"data":{"mode":"pixel"},"ignorable":true}',
      patched: true,
    })
    expect(patchEventLine('{"type":"session/title","seq":7,"time":3,"data":{"title":"x"}}').patched).toBe(false)
    expect(patchEventLine('not json').patched).toBe(false)
    expect(patchEventLine('null').patched).toBe(false)

    const text = `{"type":"session","version":4}\n${event}\n`
    const first = patchLogText(text)
    expect(first.count).toBe(1)
    expect(first.text).toContain('"ignorable":true')
    expect(patchLogText(first.text).count).toBe(0)
  })

  it('patches the plugin: migration alias too and keeps line endings', () => {
    const alias = '{"type":"plugin:computer-use/coordinate-mode","seq":6,"data":{"mode":"pixel"}}\r\n'
    const result = patchLogText(`{"type":"session","version":4}\r\n${alias}`)
    expect(result.count).toBe(1)
    expect(result.text).toContain('"ignorable":true')
    expect(result.text).toContain('\r\n')
    expect(result.text.split('\n').length).toBe(3)
  })

  it('repairs a multi-frame artifact, recompressing only changed frames', () => {
    const header = frame('{"type":"session","version":4,"id":"session-x"}\n')
    const clean = frame('{"type":"model/selection","seq":1,"time":1,"data":{}}\n')
    const marked = frame('{"type":"computer-use/coordinate-mode","seq":6,"time":2,"data":{"mode":"millifraction"}}\n')
    const buffer = Buffer.concat([header, clean, marked])
    const result = repairLogBuffer(buffer)
    expect(result.changed).toBe(true)
    expect(result.count).toBe(1)
    const text = decodeLogBuffer(result.buffer)
    expect(text).toContain('"ignorable":true')
    expect(countLines(text)).toBe(countLines(decodeLogBuffer(buffer)))
    expect(result.buffer.subarray(0, header.length).equals(header)).toBe(true)
  })

  it('finds only session.v3/v4 artifacts and skips backup trees', () => {
    const root = tempRoot()
    artifact(root, join('--ws--', 'session-a', 'session.v4.jsonl.zstd'), [frame('{"type":"session","version":4}\n')])
    artifact(root, join('--ws--', 'session-b', 'session.v3.jsonl.zstd'), [frame('{"type":"session","version":3}\n')])
    artifact(root, join('--ws--', 'session-c', 'session.jsonl.zstd'), [frame('{"type":"session","version":1}\n')])
    artifact(root, join('.backup-x', 'session-a', 'session.v4.jsonl.zstd'), [frame('{"type":"session","version":4}\n')])
    const found = findLogFiles(root)
    expect(found).toHaveLength(2)
    expect(found.some(file => file.endsWith('session.v4.jsonl.zstd'))).toBe(true)
    expect(found.some(file => file.endsWith('session.v3.jsonl.zstd'))).toBe(true)
    expect(found.some(file => file.includes('.backup-x'))).toBe(false)
  })

  it('repairs a sessions tree with backups, manifest, and dry-run support', () => {
    const root = tempRoot()
    const poisoned = artifact(root, join('--ws--', 'session-a', 'session.v4.jsonl.zstd'), [
      frame('{"type":"session","version":4,"id":"session-a"}\n'),
      frame('{"type":"computer-use/coordinate-mode","seq":6,"time":2,"data":{"mode":"pixel"}}\n'),
    ])
    const clean = artifact(root, join('--ws--', 'session-b', 'session.v4.jsonl.zstd'), [
      frame('{"type":"session","version":4,"id":"session-b"}\n'),
    ])

    const dry = repairSessions({ sessionsDir: root, dryRun: true, skipRecentMin: 0 })
    expect(dry.summary.patched).toBe(1)
    expect(readFileSync(poisoned).equals(readFileSync(poisoned))).toBe(true)
    expect(decodeLogBuffer(readFileSync(poisoned))).not.toContain('"ignorable":true')

    const applied = repairSessions({ sessionsDir: root, skipRecentMin: 0 })
    expect(applied.summary.patched).toBe(1)
    expect(applied.summary.unchanged).toBe(1)
    expect(applied.summary.failed).toBe(0)
    const repairedText = decodeCompleteFrames(readFileSync(poisoned))
    expect(repairedText).toContain('"ignorable":true')
    expect(readFileSync(clean).byteLength).toBeGreaterThan(0)

    const files = readFileSync(join(applied.backupDir, '--ws--', 'session-a', 'session.v4.jsonl.zstd'))
    expect(decodeLogBuffer(files)).not.toContain('"ignorable":true')
    const manifest = JSON.parse(readFileSync(join(applied.backupDir, 'manifest.json'), 'utf8')) as {
      summary: { patched: number }
    }
    expect(manifest.summary.patched).toBe(1)

    const again = repairSessions({ sessionsDir: root, skipRecentMin: 0 })
    expect(again.summary.patched).toBe(0)
    expect(again.summary.unchanged).toBe(2)

    const recent = repairSessions({ sessionsDir: root, skipRecentMin: 60 })
    expect(recent.summary.skippedRecent).toBe(2)
  })
})
