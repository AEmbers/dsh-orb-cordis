/**
 * Where the helper's files are.
 * Installed `dsh-orb` keeps them next to this file: `dist/host/index.js` and `dist/helper/lib/main.js`.
 * In the workspace the helper is a separate package that Node resolves by name.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** Root folder of the helper: holds `lib/`, `assets/` and the preload scripts. */
export function helperRoot(): string {
  const assembled = fileURLToPath(new URL('../helper', import.meta.url))
  if (existsSync(join(assembled, 'lib', 'main.js'))) return assembled
  return dirname(require.resolve('@dsh-orb/helper/package.json'))
}

/** Electron entry script of the helper. */
export function helperMain(): string {
  return join(helperRoot(), 'lib', 'main.js')
}

/** Bundled default avatar. */
export function defaultAvatarPath(): string {
  return join(helperRoot(), 'assets', 'deepseek-avatar-square.gif')
}

/** Built-in avatar GIFs. The ball loads them from disk, the settings page over the route. */
export function presetAvatarDir(): string {
  return join(helperRoot(), 'assets', 'avatars')
}
