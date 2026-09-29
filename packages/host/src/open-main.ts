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

/** Desktop uses the app's `dsh://open` protocol. `dsh web` opens the loopback page. */
export function mainWindowTarget(ctx: OpenContext, desktop = isDesktopHost()): string | undefined {
  if (desktop) return 'dsh://open'
  return localPage(ctx)
}

/** Command used to focus that window. The target is never logged. */
export function openCommand(target: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] }
  return { command: 'open', args: [target] }
}

/** Desktop uses the app's `dsh://open` protocol. `dsh web` opens the loopback page. */
export async function openMainWindow(ctx: OpenContext): Promise<void> {
  const target = mainWindowTarget(ctx)
  if (target === undefined) return
  await spawnOpen(target)
}

function localPage(ctx: OpenContext): string | undefined {
  let url: string
  try {
    url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`)
  } catch {
    console.error('dsh-orb: main window URL is unavailable')
    return undefined
  }
  try {
    const hostname = new URL(url).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      console.error('dsh-orb: main window URL is not loopback')
      return undefined
    }
  } catch {
    console.error('dsh-orb: main window URL is unavailable')
    return undefined
  }
  return url
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
