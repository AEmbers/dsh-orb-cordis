import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readAppearance, watchAppearance } from '../src/appearance.ts'

function settingsService(rows: { ns: string; value?: unknown }[]) {
  const listeners: ((ns: unknown, revision: unknown) => void)[] = []
  const service = {
    describe: () => rows.map((row) => ({ ns: row.ns, value: row.value })),
  }
  return {
    service,
    updated(ns: string): void {
      for (const listener of [...listeners]) listener(ns, 1)
    },
    listenerCount(): number {
      return listeners.length
    },
    ctx: {
      get(name: string) {
        return name === 'settings' ? service : undefined
      },
      on(name: string, listener: (...args: unknown[]) => void) {
        if (name === 'settings/document-updated') listeners.push(listener as (ns: unknown, revision: unknown) => void)
        return () => {}
      },
    },
  }
}

describe('appearance preferences', () => {
  it('reads the ui-theme and locale sections', () => {
    const harness = settingsService([
      { ns: 'ui-theme', value: { preference: 'dark', fontSize: 14 } },
      { ns: 'locale', value: { preference: 'zh' } },
      { ns: 'orb-host', value: { autoStart: true } },
    ])
    assert.deepEqual(readAppearance(harness.service), { theme: 'dark', locale: 'zh' })
  })

  it('stays absent when sections are missing or malformed', () => {
    const harness = settingsService([
      { ns: 'ui-theme', value: { preference: 'neon' } },
      { ns: 'locale', value: {} },
    ])
    assert.deepEqual(readAppearance(harness.service), {})
    assert.deepEqual(readAppearance(undefined), {})
    assert.deepEqual(readAppearance({ describe: () => { throw new Error('boom') } }), {})
  })

  it('notifies once with the initial read, then on matching revisions', () => {
    const harness = settingsService([
      { ns: 'ui-theme', value: { preference: 'system' } },
      { ns: 'locale', value: { preference: 'zh' } },
    ])
    const seen: { theme?: string; locale?: string }[] = []
    const detach = watchAppearance(harness.ctx, (appearance) => { seen.push({ ...appearance }) })
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { theme: 'system', locale: 'zh' })

    // Other namespaces never notify.
    harness.updated('orb-host')
    assert.equal(seen.length, 1)

    harness.updated('ui-theme')
    assert.equal(seen.length, 1, 'unchanged values stay silent')

    harness.service.describe = () => [{ ns: 'ui-theme', value: { preference: 'dark' } }, { ns: 'locale', value: { preference: 'zh' } }]
    harness.updated('ui-theme')
    assert.equal(seen.length, 2)
    assert.deepEqual(seen[1], { theme: 'dark', locale: 'zh' })

    harness.service.describe = () => [{ ns: 'ui-theme', value: { preference: 'dark' } }]
    harness.updated('locale')
    assert.equal(seen.length, 3)
    assert.deepEqual(seen[2], { theme: 'dark' })
    detach()
  })

  it('survives a missing settings service', () => {
    const seen: unknown[] = []
    const detach = watchAppearance({ get: () => undefined, on: () => () => {} }, (appearance) => { seen.push(appearance) })
    assert.deepEqual(seen, [])
    detach()
  })
})
