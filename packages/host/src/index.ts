/**
 * Host-side Orb plugin.
 * The ball is a separate Electron process. This plugin owns the socket and the Computer Use session.
 */

import { OrbRuntime, type OrbContext } from './orb.ts'

/** Cordis plugin name. */
export const name = 'orb-host'

/** Official services this plugin reads. Missing ones keep it pending. */
export const inject = [
  'webServer',
  'connection',
  'sessionController',
  'workspaceController',
  'sessions',
]

export type { OrbContext }

/**
 * Log the web port, then start the ball unless this is Linux or autoStart is off.
 * @param ctx - host services named in {@link inject}.
 * @param config - patch config. `autoStart: false` leaves Computer Use in the main window only.
 */
export function apply(ctx: OrbContext, config: { autoStart?: boolean } = {}): void {
  logWebPort(ctx)
  if (process.platform === 'linux' || config.autoStart === false) return
  const runtime = new OrbRuntime(ctx)
  ctx.effect(() => {
    void runtime.start().catch((error: unknown) => {
      console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      runtime.stop()
    }
  })
}

/** Print the loopback port. The authenticated URL contains credentials, so it is never logged. */
function logWebPort(ctx: OrbContext): void {
  const port = ctx.webServer.port
  try {
    const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`)
    const hostname = new URL(authed).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      console.error('dsh-orb: authenticated URL is not loopback')
    }
  } catch {
    console.error('dsh-orb: authenticated URL is unavailable')
  }
  console.error(`dsh-orb: host web port ${port}`)
}
