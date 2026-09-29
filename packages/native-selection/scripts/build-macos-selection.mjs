/** Compile the Darwin selection dylib. Install does not run this script. */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const swiftSource = resolve(packageRoot, 'src/macos-selection.swift')
const output = resolve(packageRoot, `prebuilds/darwin-${process.arch}/libmacos-selection.dylib`)

if (process.platform !== 'darwin') {
  console.error('macos selection: skip, not Darwin')
  process.exit(0)
}

mkdirSync(dirname(output), { recursive: true })
const result = spawnSync('swiftc', [
  '-O',
  '-parse-as-library',
  '-emit-library',
  '-Xlinker', '-install_name',
  '-Xlinker', '@rpath/libmacos-selection.dylib',
  '-o', output,
  swiftSource,
  '-framework', 'AppKit',
  '-framework', 'ApplicationServices',
  '-framework', 'CoreGraphics',
], { cwd: packageRoot, stdio: 'inherit' })
if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`libmacos-selection: swiftc exited with ${String(result.status ?? result.signal)}`)
}
console.error(`libmacos-selection: ${output}`)
