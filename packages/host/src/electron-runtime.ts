/**
 * Locate the generic Electron binary used to open the ball.
 * Official DeepSeek Harness is not a usable helper runtime: it has its own app payload and a single-instance lock.
 */

import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Matches the official app's Electron framework and the fork's desktop package. */
const ELECTRON_VERSION = '44.0.0'

const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`

/**
 * Resolve the helper executable.
 * `DSH_ORB_ELECTRON_PATH` wins. Otherwise use the cached official zip, downloading it once.
 * @returns absolute path to the Electron executable.
 */
export async function resolveElectronBinary(): Promise<string> {
  const override = process.env.DSH_ORB_ELECTRON_PATH?.trim()
  if (override) {
    await access(override)
    return override
  }
  const dest = dshHomePath('dsh-orb', 'electron-runtime')
  const binary = join(dest, binaryRelative())
  const marker = join(dest, `.complete-${ELECTRON_VERSION}`)
  if (await exists(binary) && await exists(marker)) return binary
  await downloadRuntime(dest, binary, marker)
  return binary
}

async function downloadRuntime(dest: string, binary: string, marker: string): Promise<void> {
  const fileName = assetName()
  console.error(`dsh-orb: downloading Electron ${ELECTRON_VERSION} (${fileName})`)
  const sums = await fetchText(`${RELEASE_BASE}/SHASUMS256.txt`)
  const expected = expectedHash(sums, fileName)
  const zipPath = join(tmpdir(), `dsh-orb-${fileName}`)
  try {
    await downloadVerifiedZip(fileName, expected, zipPath)
    await rm(dest, { recursive: true, force: true })
    await mkdir(dest, { recursive: true })
    await extractZip(zipPath, dest)
    if (process.platform === 'darwin') {
      await spawnChecked('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dest]).catch(() => undefined)
    }
    await chmod(binary, 0o755)
    await access(binary)
    await writeFile(marker, `${ELECTRON_VERSION}\n`)
  } finally {
    await rm(zipPath, { force: true })
  }
  console.error(`dsh-orb: Electron ${ELECTRON_VERSION} is ready`)
}

function assetName(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(`dsh-orb: unsupported platform ${platform}`)
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`dsh-orb: unsupported architecture ${arch}`)
  }
  return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`
}

function binaryRelative(): string {
  if (process.platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron')
  if (process.platform === 'win32') return 'electron.exe'
  return 'electron'
}

function expectedHash(sums: string, fileName: string): string {
  for (const line of sums.split('\n')) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (match?.[2] === fileName) return match[1].toLowerCase()
  }
  throw new Error(`dsh-orb: ${fileName} is missing from Electron ${ELECTRON_VERSION} checksums`)
}

async function fetchText(url: string): Promise<string> {
  const { stdout } = await run('curl', ['-fsSL', '--max-time', '60', url])
  return stdout
}

async function downloadVerifiedZip(fileName: string, expected: string, dest: string): Promise<void> {
  // Official checksums decide what is accepted. A second URL only helps when GitHub is too slow.
  const urls = [
    `${RELEASE_BASE}/${fileName}`,
    `https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}/${fileName}`,
  ]
  let lastError: unknown
  for (const url of urls) {
    try {
      await rm(dest, { force: true })
      await run('curl', [
        '-fsSL', '--retry', '2', '--retry-delay', '1',
        '--speed-limit', '100000', '--speed-time', '20',
        '--max-time', '300', '-o', dest, url,
      ])
      const actual = await sha256(dest)
      if (!sameHash(actual, expected)) {
        throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum did not match SHASUMS256.txt`)
      }
      return
    } catch (error) {
      lastError = error
      console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`dsh-orb: failed to download Electron ${ELECTRON_VERSION}`)
}

function run(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString('utf8') })
        return
      }
      const detail = Buffer.concat(err).toString('utf8').trim()
      reject(new Error(`dsh-orb: ${command} exited ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`))
    })
  })
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function sameHash(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'hex')
  const right = Buffer.from(expected, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

async function extractZip(zipPath: string, dest: string): Promise<void> {
  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${dest.replaceAll("'", "''")}' -Force`
    await spawnChecked('powershell.exe', ['-NoProfile', '-Command', command])
    return
  }
  const unzip = process.platform === 'darwin' ? '/usr/bin/unzip' : 'unzip'
  await spawnChecked(unzip, ['-q', '-o', zipPath, '-d', dest])
}

function spawnChecked(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`dsh-orb: ${command} exited ${code ?? 'unknown'}`))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
