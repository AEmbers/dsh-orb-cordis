/**
 * Avatar messages from the host.
 * The host owns what the avatar is; the helper only turns that into something the
 * ball page can load: a relative asset path, the uploaded bytes, or nothing (the
 * GIF that ships with the page).
 */

/** `kind: 'preset'` sources: a plain relative GIF path, never a URL scheme or a parent hop. */
const PRESET_SRC = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9_-]+)*\.gif$/

export type AvatarChoice =
  | { kind: 'default' }
  | { kind: 'preset'; src: string }
  | { kind: 'custom'; version: number }

export function readAvatarChoice(record: Record<string, unknown>): AvatarChoice {
  if (record.kind === 'preset' && typeof record.src === 'string' && PRESET_SRC.test(record.src)) {
    return { kind: 'preset', src: record.src }
  }
  const version = typeof record.version === 'number' && Number.isFinite(record.version) ? Math.trunc(record.version) : 0
  if (record.kind === 'custom' && version > 0) return { kind: 'custom', version }
  return { kind: 'default' }
}
