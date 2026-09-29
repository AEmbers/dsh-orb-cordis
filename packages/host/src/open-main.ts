/**
 * Focus the official desktop window, or open the local web page.
 * The credentialed page address is never written to the log.
 */

import { spawn } from 'node:child_process'
import { isDesktopHost } from './tcc.ts'

interface OpenContext {
  readonly webServer: { readonly port: number }
  readonly connection: { authenticatedUrl(baseUrl: string): string }
}

/**
 * Desktop uses the app's `dsh://open` protocol.
 * `dsh web` has no main window, so the menu item stays disabled and this returns undefined.
 * The credentialed loopback URL is never passed to `open` or `cmd`.
 */
export function mainWindowTarget(_ctx: OpenContext, desktop = isDesktopHost()): string | undefined {
  if (desktop) return 'dsh://open'
  return undefined
}

/** Command used to focus that window. The target is never logged. */
export function openCommand(target: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] }
  return { command: 'open', args: [target] }
}

/** Focus the desktop main window. Does nothing when this host is `dsh web`. */
export async function openMainWindow(ctx: OpenContext): Promise<void> {
  const target = mainWindowTarget(ctx)
  if (target === undefined) return
  await spawnOpen(target)
}

function spawnOpen(target: string): Promise<void> {
  const { command, args } = openCommand(target)
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => {
      console.error('dsh-orb: could not open the main window')
      resolve()
    })
    child.once('exit', (code) => {
      if (code !== 0) console.error('dsh-orb: could not open the main window')
      resolve()
    })
  })
}
