import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ProfileStore } from '../src/preferences.ts'
import { installOrbServices, pinSessionId, watchOrbPermissions } from '../src/services.ts'

const home = mkdtempSync(join(tmpdir(), 'orb-services-'))
process.env.DSH_HOME = home
const profile = join(home, 'profile')
mkdirSync(profile, { recursive: true })
const orb = dshHomePath('dsh_orb')

after(() => { rmSync(home, { recursive: true, force: true }) })

interface Session {
  header?: { cwd?: string; agentPreset?: string }
}

describe('Computer Use services', () => {
  it('publishes the background model and the coordinate mode', () => {
    const store = new ProfileStore(profile)
    store.setBackground({ provider: 'deepseek-official', model: 'background', reasoningEffort: 'low' })
    store.setOverlay({ provider: 'deepseek-official', model: 'overlay', reasoningEffort: 'max' })
    store.setMillifractionEnabled(true)
    const provided = new Map<string, { currentSelection?: () => unknown; currentMode?: () => unknown }>()
    installOrbServices({
      get: () => undefined,
      provide: (name, value) => { provided.set(name, value as { currentSelection?: () => unknown; currentMode?: () => unknown }) },
      on: () => () => {},
    }, store)
    assert.deepEqual(provided.get('orbCodeAgentModel')?.currentSelection?.(), {
      provider: 'deepseek-official',
      model: 'background',
      reasoningEffort: 'low',
    })
    assert.equal(provided.get('orbCoordinateMode')?.currentMode?.(), 'millifraction')
  })

  it('pins Computer Use and standard sessions under dsh_orb, including later subdirectories', () => {
    const pins = join(home, 'pins')
    mkdirSync(pins, { recursive: true })
    const store = new ProfileStore(pins)
    store.setPermission('workspace-write')
    const pinned: { preset: string; cwd?: string; agent?: string }[] = []
    let created: ((session: Session) => void) | undefined
    const sessions = new Map<string, Session>()
    const ctx = {
      get(name: string) {
        if (name === 'permissionPresets') {
          return {
            set(session: Session, preset: string) {
              pinned.push({ preset, cwd: session.header?.cwd, agent: session.header?.agentPreset })
            },
          }
        }
        if (name === 'sessions') return { get: (id: string) => sessions.get(id) }
        return undefined
      },
      provide() {},
      on(_name: 'session/created', listener: (session: Session) => void) {
        created = listener
        return () => { created = undefined }
      },
    }
    const stop = watchOrbPermissions(ctx, store)
    const emit = (session: Session) => { created?.(session) }
    emit({ header: { cwd: orb, agentPreset: 'computer-use' } })
    emit({ header: { cwd: join(orb, 'job'), agentPreset: 'standard' } })
    emit({ header: { cwd: `${orb}-extra`, agentPreset: 'computer-use' } })
    emit({ header: { cwd: '/tmp/elsewhere', agentPreset: 'computer-use' } })
    emit({ header: { cwd: orb, agentPreset: 'code_agent' } })
    emit({ header: { agentPreset: 'computer-use' } })
    assert.deepEqual(pinned, [
      { preset: 'workspace-write', cwd: orb, agent: 'computer-use' },
      { preset: 'workspace-write', cwd: join(orb, 'job'), agent: 'standard' },
    ])
    sessions.set('session-live', { header: { cwd: orb, agentPreset: 'computer-use' } })
    pinSessionId(ctx, 'session-live', 'read-only')
    pinSessionId(ctx, 'session-missing', 'read-only')
    assert.equal(pinned.at(-1)?.preset, 'read-only')
    stop()
    emit({ header: { cwd: orb, agentPreset: 'computer-use' } })
    assert.equal(pinned.length, 3)
  })
})
