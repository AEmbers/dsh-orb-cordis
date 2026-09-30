/**
 * Appearance preferences the ball mirrors: the official theme and locale
 * settings (`ui-theme.preference`, `locale.preference`) read through the host
 * `settings` service. The raw preference travels as stored — the helper
 * resolves `system` against its own native theme and an absent locale against
 * its own system languages, matching how the web client resolves both.
 */

/** Built-in theme preferences accepted by the official ui-theme plugin. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** The two stored preferences, each absent when the section has no value. */
export interface Appearance {
  theme?: ThemePreference
  locale?: string
}

interface SettingsDescriptor {
  ns?: unknown
  value?: { preference?: unknown }
}

type SettingsService = { describe?: () => SettingsDescriptor[] }

function describeSettings(settings: unknown): SettingsDescriptor[] {
  const describe = (settings as SettingsService | undefined)?.describe
  if (typeof describe !== 'function') return []
  try {
    const rows = describe.call(settings)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** Read the stored theme and locale preferences; unusable sections stay absent. */
export function readAppearance(settings: unknown): Appearance {
  const appearance: Appearance = {}
  for (const row of describeSettings(settings)) {
    if (row?.ns === 'ui-theme') {
      const preference = row.value?.preference
      if (preference === 'light' || preference === 'dark' || preference === 'system') {
        appearance.theme = preference
      }
    }
    if (row?.ns === 'locale' && typeof row.value?.preference === 'string') {
      const preference = row.value.preference
      if (preference.length > 0 && preference.length <= 35) appearance.locale = preference
    }
  }
  return appearance
}

function sameAppearance(left: Appearance, right: Appearance): boolean {
  return left.theme === right.theme && left.locale === right.locale
}

/**
 * Follow the live settings document: read once, then re-read whenever the
 * theme or locale namespace changes. `settings/document-updated` fires for
 * every namespace and describe() itself emits it, so the read is guarded
 * against re-entry.
 */
export function watchAppearance(
  ctx: { get(name: string): unknown; on(name: string, listener: (...args: unknown[]) => void): unknown },
  onChange: (appearance: Appearance) => void,
): () => void {
  const settings = ctx.get('settings')
  const describe = (settings as SettingsService | undefined)?.describe
  if (typeof describe !== 'function') return () => {}
  let reading = false
  const read = (): Appearance => {
    if (reading) return {}
    reading = true
    try {
      return readAppearance(settings)
    } finally {
      reading = false
    }
  }
  let current = read()
  onChange({ ...current })
  const detach = ctx.on('settings/document-updated', (ns: unknown) => {
    if (ns !== 'ui-theme' && ns !== 'locale') return
    const next = read()
    if (sameAppearance(next, current)) return
    current = next
    onChange({ ...current })
  })
  return typeof detach === 'function' ? (detach as () => void) : () => {}
}
