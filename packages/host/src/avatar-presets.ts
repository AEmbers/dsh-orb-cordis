/**
 * Built-in ball avatars.
 * The files are animated GIFs in the helper's `assets/avatars`. The ball picks one
 * by relative path (a data URL would have to carry megabytes through the socket),
 * while the settings page reads the same files through the avatar route.
 */

import { join } from 'node:path'
import { presetAvatarDir } from './helper-path.ts'

export interface AvatarPreset {
  /** Stable id: stored in the profile, sent to the settings page. */
  readonly id: string
  /** File inside `assets/avatars`. */
  readonly file: string
}

/** Gallery order is this order. */
export const AVATAR_PRESETS: readonly AvatarPreset[] = [
  { id: 'point', file: 'point.gif' },
  { id: 'rice', file: 'rice.gif' },
  { id: 'heart', file: 'heart.gif' },
  { id: 'cheer', file: 'cheer.gif' },
  { id: 'cheeks', file: 'cheeks.gif' },
  { id: 'smile', file: 'smile.gif' },
]

export function findAvatarPreset(id: string): AvatarPreset | undefined {
  return AVATAR_PRESETS.find((preset) => preset.id === id)
}

export function isAvatarPresetId(value: unknown): value is string {
  return typeof value === 'string' && findAvatarPreset(value) !== undefined
}

/** Absolute path of a shipped preset. Unknown ids resolve to nothing, so a request cannot walk the disk. */
export function avatarPresetPath(id: string): string | undefined {
  const preset = findAvatarPreset(id)
  return preset === undefined ? undefined : join(presetAvatarDir(), preset.file)
}

/** Source the ball page reads, relative to the ball's own document. */
export function avatarPresetSrc(id: string): string | undefined {
  const preset = findAvatarPreset(id)
  return preset === undefined ? undefined : `avatars/${preset.file}`
}
