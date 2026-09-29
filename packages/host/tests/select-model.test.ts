import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectModelKeepDefault } from '../src/select-model.ts'

function fakeHost(events: string[]) {
  let current = { provider: 'p', model: 'default' }
  return {
    sessionController: {
      async selectModel(request: { sessionId: string; provider: string; model: string }) {
        events.push(`start ${request.sessionId}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        current = { provider: request.provider, model: request.model }
        events.push(`end ${request.sessionId}`)
      },
    },
    agentDefaultModel: {
      currentSelection: () => current,
      async saveSelection(next: { provider: string; model: string }) {
        events.push(`restore ${next.model}`)
        current = next
      },
    },
    get value() { return current },
  }
}

describe('selectModelKeepDefault', () => {
  it('puts the previous default back after a session-only selection', async () => {
    const events: string[] = []
    const host = fakeHost(events)
    await selectModelKeepDefault(host, { sessionId: 's1', provider: 'p', model: 'chosen' })
    assert.deepEqual(events, ['start s1', 'end s1', 'restore default'])
    assert.equal(host.value.model, 'default')
  })

  it('runs concurrent selections one after another', async () => {
    const events: string[] = []
    const host = fakeHost(events)
    await Promise.all([
      selectModelKeepDefault(host, { sessionId: 'a', provider: 'p', model: 'x' }),
      selectModelKeepDefault(host, { sessionId: 'b', provider: 'p', model: 'y' }),
    ])
    assert.deepEqual(events, ['start a', 'end a', 'restore default', 'start b', 'end b', 'restore default'])
    assert.equal(host.value.model, 'default')
  })

  it('keeps the queue alive after a failed selection', async () => {
    const events: string[] = []
    const host = fakeHost(events)
    const failing = { ...host, sessionController: { selectModel: async () => { throw new Error('nope') } } }
    await assert.rejects(selectModelKeepDefault(failing, { sessionId: 'bad', provider: 'p', model: 'x' }), /nope/)
    await selectModelKeepDefault(host, { sessionId: 'ok', provider: 'p', model: 'y' })
    assert.equal(host.value.model, 'default')
  })
})
