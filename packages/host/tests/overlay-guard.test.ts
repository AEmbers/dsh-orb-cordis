import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOverlayGuard, type OverlayGuardTransport } from '../src/overlay-guard.ts'

function transport(overrides: Partial<OverlayGuardTransport> = {}): OverlayGuardTransport & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    hasHelper: () => true,
    send: async (message) => { sent.push(message.type) },
    setHidInput: () => undefined,
    sleep: async () => undefined,
    ...overrides,
  }
}

describe('overlay guard capture exclusion', () => {
  it('hands the helper chrome handles to every capture, including one inside an input interval', async () => {
    const host = transport({ chromeWindowIds: () => [11, 22] })
    const guard = createOverlayGuard(host)
    const seen: (readonly number[])[] = []
    await guard.withCapture(async (session) => { seen.push(session.excludeWindowIds) })
    await guard.withInput(async () => {
      await guard.withCapture(async (session) => { seen.push(session.excludeWindowIds) })
    })
    assert.deepEqual(seen, [[11, 22], [11, 22]])
    // The nested capture posts no IPC: the surrounding input interval already cloaks the chrome.
    assert.deepEqual(host.sent, ['overlay-capture', 'overlay-capture', 'overlay-input', 'overlay-input'])
  })

  it('excludes nothing when the helper reports no handles, which is the macOS case', async () => {
    const guard = createOverlayGuard(transport())
    const seen: (readonly number[])[] = []
    await guard.withCapture(async (session) => { seen.push(session.excludeWindowIds) })
    assert.deepEqual(seen, [[]])
  })

  it('still excludes the chrome when there is no helper to cloak through', async () => {
    const guard = createOverlayGuard(transport({ hasHelper: () => false, chromeWindowIds: () => [11] }))
    const seen: (readonly number[])[] = []
    await guard.withCapture(async (session) => { seen.push(session.excludeWindowIds) })
    assert.deepEqual(seen, [[11]])
  })
})
