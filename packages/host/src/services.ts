/**
 * Optional services Computer Use already looks up, plus the Access preset pinned on orb sessions.
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isPermissionPreset, type PermissionPreset, type ProfileStore } from './preferences.ts'

interface SessionLike {
  readonly header?: {
    readonly cwd?: string
    readonly agentPreset?: string
  }
}

interface ServiceContext {
  get(name: string): unknown
  provide(name: string, value: unknown): void
  on(name: 'session/created', listener: (session: SessionLike) => void): (() => void) | void
}

/**
 * Publish the two model/coordinate services for the life of the plugin.
 * @param ctx - host context. `provide` is called once.
 * @param store - profile preferences.
 */
export function installOrbServices(ctx: ServiceContext, store: ProfileStore): void {
  ctx.provide('orbCodeAgentModel', {
    currentSelection: () => store.models().background,
  })
  ctx.provide('orbCoordinateMode', {
    currentMode: () => store.coordinateMode(),
  })
}

/**
 * Pin the stored Access preset on Computer Use and background sessions under `dsh_orb`.
 * @returns a disposer for the create listener.
 */
export function watchOrbPermissions(ctx: ServiceContext, store: ProfileStore): () => void {
  const dispose = ctx.on('session/created', (session) => {
    pinSession(ctx, session, store.permission())
  })
  return typeof dispose === 'function' ? dispose : () => {}
}

/** Pin one already-open session when the chip or a reopen asks for it. */
export function pinSessionId(ctx: { get(name: string): unknown }, sessionId: string, preset: PermissionPreset): void {
  const sessions = ctx.get('sessions') as { get?(id: string): SessionLike | undefined } | undefined
  const session = sessions?.get?.(sessionId)
  if (session) pinSession(ctx, session, preset)
}

function pinSession(ctx: { get(name: string): unknown }, session: SessionLike, preset: PermissionPreset): void {
  if (!isOrbSession(session)) return
  const presets = ctx.get('permissionPresets') as { set?(session: SessionLike, name: string): void } | undefined
  if (typeof presets?.set !== 'function') return
  if (!isPermissionPreset(preset)) return
  try {
    presets.set(session, preset)
  } catch (error) {
    console.error(`dsh-orb: permission preset failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isOrbSession(session: SessionLike): boolean {
  const preset = session.header?.agentPreset
  const cwd = session.header?.cwd
  if ((preset !== 'computer-use' && preset !== 'standard') || cwd === undefined) return false
  return isOrbWorkspace(cwd, dshHomePath('dsh_orb'))
}

function isOrbWorkspace(cwd: string, orbCwd: string): boolean {
  const resolved = resolve(cwd)
  const orb = resolve(orbCwd)
  if (resolved === orb) return true
  const rel = relative(orb, resolved)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
