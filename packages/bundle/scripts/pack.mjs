/**
 * Build one installable tarball. The package is self-contained: `assemble.mjs` puts every part inside it.
 * The tarball manifest drops workspace-only fields so a plain install resolves `koffi` and `zod` from npm.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(bundleRoot, '../..')

const stage = await mkdtemp(join(tmpdir(), 'dsh-orb-pack-'))
const pkgDir = join(stage, 'package')

try {
  // Assemble straight into the staging folder so a linked install keeps its own files.
  const assembled = spawnSync(process.execPath, [join(bundleRoot, 'scripts', 'assemble.mjs'), '--out', pkgDir], { stdio: 'inherit' })
  if (assembled.status !== 0) process.exit(assembled.status ?? 1)
  const manifest = JSON.parse(await readFile(join(bundleRoot, 'package.json'), 'utf8'))
  delete manifest.scripts
  delete manifest.devDependencies
  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const packed = spawnSync('npm', ['pack', '--pack-destination', repoRoot], { cwd: pkgDir, stdio: 'inherit' })
  if (packed.status !== 0) process.exit(packed.status ?? 1)
} finally {
  await rm(stage, { recursive: true, force: true })
}
