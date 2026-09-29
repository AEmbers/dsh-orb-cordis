/** Compile the Darwin ScreenCaptureKit helper into native/, as a universal macOS 14 binary. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(packageRoot, 'src/macos-sck-capture.swift')
const output = resolve(packageRoot, 'native/macos-sck-capture')
const dylib = resolve(packageRoot, 'native/libmacos-sck-capture.dylib')
const frameworks = [
  '-framework', 'AppKit',
  '-framework', 'ScreenCaptureKit',
  '-framework', 'CoreGraphics',
  '-framework', 'ImageIO',
  '-framework', 'UniformTypeIdentifiers',
]
// SCScreenshotManager needs macOS 14. Selection stays on macOS 13.
const targets = ['arm64-apple-macos14', 'x86_64-apple-macos14']

mkdirSync(resolve(packageRoot, 'native'), { recursive: true })
if (process.platform !== 'darwin') {
  writeFileSync(output, 'macos-sck-capture is Darwin-only\n')
  writeFileSync(dylib, 'libmacos-sck-capture is Darwin-only\n')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-orb-sck-'))
try {
  const cliParts = targets.map((target) => compile(target, `cli-${target}`, [
    '-parse-as-library',
    '-D', 'DSH_SCK_CLI',
  ]))
  const dylibParts = targets.map((target) => compile(target, `lib-${target}.dylib`, [
    '-parse-as-library',
    '-emit-library',
    '-Xlinker', '-install_name',
    '-Xlinker', '@rpath/libmacos-sck-capture.dylib',
  ]))
  lipo(cliParts, output)
  lipo(dylibParts, dylib)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

function compile(target, name, extra) {
  const out = join(scratch, name)
  const result = spawnSync('swiftc', [
    '-O',
    '-target', target,
    ...extra,
    '-o', out,
    source,
    ...frameworks,
  ], { cwd: packageRoot, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`macos-sck-capture ${target}: swiftc exited with ${String(result.status ?? result.signal)}`)
  }
  return out
}

function lipo(parts, dest) {
  const result = spawnSync('lipo', ['-create', ...parts, '-output', dest], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`lipo ${dest}: exited with ${String(result.status ?? result.signal)}`)
  }
}
