/** Compile the Darwin selection dylib as a universal macOS 13 binary. Install does not run this script. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const swiftSource = resolve(packageRoot, 'src/macos-selection.swift')
const output = resolve(packageRoot, 'prebuilds/darwin-universal/libmacos-selection.dylib')
const targets = ['arm64-apple-macos13', 'x86_64-apple-macos13']

if (process.platform !== 'darwin') {
  console.error('macos selection: skip, not Darwin')
  process.exit(0)
}

mkdirSync(resolve(packageRoot, 'prebuilds/darwin-universal'), { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'dsh-orb-selection-'))
try {
  const parts = targets.map((target) => {
    const out = join(scratch, `${target}.dylib`)
    const result = spawnSync('swiftc', [
      '-O',
      '-target', target,
      '-parse-as-library',
      '-emit-library',
      '-Xlinker', '-install_name',
      '-Xlinker', '@rpath/libmacos-selection.dylib',
      '-o', out,
      swiftSource,
      '-framework', 'AppKit',
      '-framework', 'ApplicationServices',
      '-framework', 'CoreGraphics',
    ], { cwd: packageRoot, stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`libmacos-selection ${target}: swiftc exited with ${String(result.status ?? result.signal)}`)
    }
    return out
  })
  const linked = spawnSync('lipo', ['-create', ...parts, '-output', output], { stdio: 'inherit' })
  if (linked.error !== undefined) throw linked.error
  if (linked.status !== 0) {
    throw new Error(`libmacos-selection lipo exited with ${String(linked.status ?? linked.signal)}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.error(`libmacos-selection: ${output}`)
