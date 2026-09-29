/** Host half of the settings page. The browser half is `./client`. */

/** Cordis plugin name. The patch id matches this. */
export const name = 'ui-settings-orb'

/** No host services. The page talks to `/.dsh-orb` from the browser. */
export const inject: string[] = []

/** The browser plugin registers the settings section. */
export function apply(): void {}
