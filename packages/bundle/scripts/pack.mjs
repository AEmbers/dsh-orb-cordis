/**
 * Build one installable tarball.
 * Workspace `file:../` links are copied into `node_modules` and packed as bundleDependencies.
 * Sibling `file:` links stay inside that folder so one tarball installs offline.
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(bundleRoot, '../..')

const VENDORS = [
  ['@dsh-orb/host', 'host'],
  ['@dsh-orb/computer-use', 'computer-use'],
  ['@dsh-orb/client-ui-settings-orb', 'client-settings'],
  ['@dsh-orb/helper', 'helper'],
  ['@dsh-orb/native-selection', 'native-selection'],
]

const stage = await mkdtemp(join(tmpdir(), 'dsh-orb-pack-'))
const pkgDir = join(stage, 'package')

try {
  await mkdir(pkgDir, { recursive: true })
  await cp(join(bundleRoot, 'lib'), join(pkgDir, 'lib'), { recursive: true })
  await cp(join(bundleRoot, 'cordis.patch.yml'), join(pkgDir, 'cordis.patch.yml'))

  const manifest = JSON.parse(await readFile(join(bundleRoot, 'package.json'), 'utf8'))
  const dependencies = {
    koffi: manifest.dependencies.koffi,
    zod: manifest.dependencies.zod,
  }
  for (const [name, dir] of VENDORS) {
    const linked = join(pkgDir, 'node_modules', ...name.split('/'))
    await mkdir(dirname(linked), { recursive: true })
    const version = await copyPackage(join(repoRoot, 'packages', dir), linked)
    dependencies[name] = version
  }
  manifest.dependencies = dependencies
  manifest.files = ['lib/index.js', 'lib/index.d.ts', 'cordis.patch.yml']
  delete manifest.private
  delete manifest.scripts
  delete manifest.devDependencies
  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const packed = spawnSync('npm', ['pack', '--pack-destination', repoRoot], {
    cwd: pkgDir,
    stdio: 'inherit',
  })
  if (packed.status !== 0) process.exit(packed.status ?? 1)
} finally {
  await rm(stage, { recursive: true, force: true })
}

async function copyPackage(src, dest) {
  const sub = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'))
  await mkdir(dest, { recursive: true })
  for (const file of sub.files ?? []) {
    await cp(join(src, file), join(dest, file), { recursive: true })
  }
  delete sub.private
  delete sub.scripts
  delete sub.devDependencies
  if (sub.dependencies !== undefined) {
    for (const [name, spec] of Object.entries(sub.dependencies)) {
      if (!String(spec).startsWith('file:')) continue
      const folder = vendorFolder(name)
      if (folder === undefined) delete sub.dependencies[name]
      else sub.dependencies[name] = `file:../${folder}`
    }
  }
  await writeFile(join(dest, 'package.json'), `${JSON.stringify(sub, null, 2)}\n`)
  return typeof sub.version === 'string' ? sub.version : '0.0.0'
}

function vendorFolder(name) {
  const entry = VENDORS.find(([pkg]) => pkg === name)
  return entry?.[0].split('/')[1]
}
