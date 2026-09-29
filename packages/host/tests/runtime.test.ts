import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { OrbRuntime, type OrbContext } from '../src/orb.ts'
import { ProfileStore } from '../src/preferences.ts'

const home = mkdtempSync(join(tmpdir(), 'orb-runtime-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'profile'), { recursive: true })
const orb = dshHomePath('dsh_orb')
const runtimes: OrbRuntime[] = []

after(() => {
  for (const runtime of runtimes) runtime.halt()
  rmSync(home, { recursive: true, force: true })
})

interface Row {
  sessionId: string
  cwd: string
  origin: string
  running?: boolean
  projections?: { values: Record<string, unknown> }
}

interface EventRow {
  type: string
  seq: number
  data: unknown
}

interface Harness {
  runtime: OrbRuntime
  store: ProfileStore
  profile: string
  calls: {
    create: { workspaceId?: string; sessionId?: string; agentPreset?: string }[]
    prompt: { sessionId?: string; content?: { text?: string }[] }[]
    cancel: { sessionId?: string }[]
    selectModel: { sessionId?: string; model?: string; saveAsDefault?: boolean; reasoningEffort?: string }[]
    workspace?: { path?: string }
  }
  listItems: Row[]
  pins: { preset: string; cwd?: string }[]
  question: (
    request: { agent?: { id?: string }; questions?: unknown },
    next: () => Promise<{ answers: { id: string; selected: string[] }[] }>,
  ) => Promise<{ answers: { id: string; selected: string[] }[] }>
  holdPrompt: () => void
  releasePrompt: () => void
}

function boot(): Harness {
  const profile = mkdtempSync(join(home, 'profile-'))
  const store = new ProfileStore(profile)
  const calls: Harness['calls'] = { create: [], prompt: [], cancel: [], selectModel: [] }
  const sessions = new Map<string, { events: EventRow[]; header: { cwd: string; agentPreset: string } }>()
  const pins: Harness['pins'] = []
  const listItems: Row[] = []
  let promptGate = Promise.resolve()
  let releasePrompt = () => {}
  let question: Harness['question'] = async (_request, next) => next()
  const replay: EventRow[] = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'notice' }, content: [{ type: 'text', text: '跳过' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      data: {
        turn: 1,
        step: 0,
        message: {
          content: [
            { type: 'text', text: '好' },
            { type: 'reasoning', text: '   ' },
            { type: 'tool-call', name: 'click', id: 'call-1' },
          ],
        },
      },
    },
  ]
  const ctx = {
    webServer: { port: 9, register: () => () => {} },
    connection: {
      authenticatedUrl: (base: string) => `${base}/?token=secret`,
      admit: () => ({ peer: {} }),
    },
    workspaceController: {
      async create(request: { path: string }) {
        calls.workspace = request
        return { workspace: { workspaceId: 'ws-orb' } }
      },
    },
    sessionController: {
      async create(request: { workspaceId?: string; sessionId?: string; agentPreset?: string }) {
        calls.create.push(request)
        const sessionId = request.sessionId ?? `session-new-${calls.create.length}`
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, {
            events: request.sessionId === 'session-keep' ? replay : [],
            header: { cwd: orb, agentPreset: 'computer-use' },
          })
        }
        return { sessionId }
      },
      async prompt(request: { sessionId?: string; content?: { text?: string }[] }) {
        calls.prompt.push(request)
        await promptGate
        return { accepted: true as const }
      },
      async list() {
        return { items: listItems }
      },
      async selectModel(request: Harness['calls']['selectModel'][number]) {
        calls.selectModel.push(request)
      },
      async cancel(request: { sessionId?: string }) {
        calls.cancel.push(request)
      },
      modelCatalog: () => ({
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }],
      }),
    },
    sessions: {
      get(id: string) {
        const row = sessions.get(id)
        if (!row) return undefined
        return { snapshotEvents: () => row.events, header: row.header }
      },
    },
    effect() {},
    get(name: string) {
      if (name === 'sessions') return ctx.sessions
      if (name === 'permissionPresets') {
        return {
          set(session: { header?: { cwd?: string } }, preset: string) {
            pins.push({ preset, cwd: session.header?.cwd })
          },
        }
      }
      return undefined
    },
    provide() {},
    on(name: string, listener: Harness['question'], options?: { prepend?: boolean }) {
      if (name === 'user-questions/request') {
        assert.equal(options?.prepend, true)
        question = listener
      }
      return () => {}
    },
  }
  const runtime = new OrbRuntime(ctx as unknown as OrbContext, store, {
    startMonitor: () => undefined,
  })
  runtime.attachQuestions()
  runtimes.push(runtime)
  return {
    runtime,
    store,
    profile,
    calls,
    listItems,
    pins,
    get question() { return question },
    holdPrompt() {
      promptGate = new Promise((resolve) => { releasePrompt = resolve })
    },
    releasePrompt() { releasePrompt() },
  }
}

async function connect(runtime: OrbRuntime) {
  const bound = await runtime.bind()
  const socket: Socket = createConnection({ host: '127.0.0.1', port: bound.port })
  const messages: Record<string, unknown>[] = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      messages.push(JSON.parse(part) as Record<string, unknown>)
    }
  })
  await once(socket, 'connect')
  socket.write(`${JSON.stringify({ type: 'hello', token: bound.token })}\n`)
  await waitFor(() => messages.some((message) => message.type === 'chrome'))
  return {
    messages,
    socket,
    send(message: unknown) { socket.write(`${JSON.stringify(message)}\n`) },
  }
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for the ball')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('ball control socket', { concurrency: 1 }, () => {
  it('lists only Computer Use chats in dsh_orb and replays one when opened', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      for (let index = 0; index < 41; index += 1) {
        harness.listItems.push({
          sessionId: `session-row-${index}`,
          cwd: orb,
          origin: 'user',
          projections: { values: { agentPreset: 'computer-use', title: `标题${index}` } },
        })
      }
      harness.listItems.push(
        { sessionId: 'session-keep', cwd: orb, origin: 'user', running: false, projections: { values: { agentPreset: 'computer-use', title: '第一段' } } },
        { sessionId: 'session-sub', cwd: orb, origin: 'subagent', projections: { values: { title: '子代理' } } },
        { sessionId: 'session-else', cwd: '/tmp/nope', origin: 'user', projections: { values: { agentPreset: 'computer-use', title: '别处' } } },
        { sessionId: 'session-std', cwd: orb, origin: 'user', projections: { values: { agentPreset: 'standard', title: '标准' } } },
        { sessionId: 'session-child', cwd: join(orb, 'child'), origin: 'user', projections: { values: { agentPreset: 'computer-use', title: '子目录' } } },
        { sessionId: 'session-blank', cwd: orb, origin: 'user', running: true },
      )
      client.send({ type: 'history' })
      await waitFor(() => client.messages.some((message) => message.type === 'history'))
      const history = client.messages.find((message) => message.type === 'history') as { items: { sessionId: string; title: string }[] }
      assert.equal(history.items.length, 40)
      assert.equal(history.items.some((item) => item.sessionId === 'session-sub'), false)
      assert.equal(history.items.some((item) => item.sessionId === 'session-else'), false)
      assert.equal(history.items.some((item) => item.sessionId === 'session-std'), false)
      assert.equal(history.items.some((item) => item.sessionId === 'session-child'), false)
      assert.equal(history.items.some((item) => item.title === '子目录'), false)
      harness.listItems.splice(0, harness.listItems.length, harness.listItems.find((item) => item.sessionId === 'session-keep') as Row)
      const mark = client.messages.length
      client.send({ type: 'open', sessionId: 'session-keep' })
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'block' && message.text === 'click'))
      const blocks = client.messages.slice(mark).filter((message) => message.type === 'block')
      assert.deepEqual(blocks.map((message) => message.text), ['你好', '好', 'click'])
      assert.equal(blocks.some((message) => message.text === '跳过'), false)
      assert.equal(harness.calls.create.at(-1)?.sessionId, 'session-keep')
      assert.equal(harness.calls.create.at(-1)?.agentPreset, 'computer-use')
      const creates = harness.calls.create.length
      client.send({ type: 'open', sessionId: 'session-missing' })
      client.send({ type: 'open', sessionId: 'not-a-session' })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(harness.calls.create.length, creates)
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('creates a session, changes both models and access, and starts a new chat for millifraction', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const session = client.messages.find((message) => message.type === 'session') as { sessionId: string }
      assert.match(session.sessionId, /^session-/)
      assert.equal(harness.calls.create[0]?.agentPreset, 'computer-use')
      assert.equal(harness.calls.create[0]?.sessionId, undefined)
      assert.deepEqual(Object.keys(harness.calls.workspace ?? {}), ['path'])
      assert.equal(harness.calls.workspace?.path, orb)
      assert.equal(harness.calls.selectModel[0]?.saveAsDefault, false)
      assert.equal(harness.calls.selectModel[0]?.sessionId, session.sessionId)
      assert.equal(harness.calls.selectModel[0]?.model, 'deepseek-flash')
      assert.equal(harness.calls.selectModel[0]?.reasoningEffort, 'max')
      const saved = JSON.parse(readFileSync(join(home, 'dsh-orb', 'floating-session.json'), 'utf8')) as { sessionId: string }
      assert.equal(saved.sessionId, session.sessionId)
      assert.equal(harness.pins.at(-1)?.preset, 'danger-full-access')
      assert.equal(harness.pins.at(-1)?.cwd, orb)

      client.send({ type: 'permission', preset: 'read-only' })
      await waitFor(() => harness.store.permission() === 'read-only')
      assert.equal(JSON.parse(readFileSync(join(harness.profile, 'orb-permission.json'), 'utf8')).preset, 'read-only')
      assert.equal(harness.pins.at(-1)?.preset, 'read-only')

      const selected = harness.calls.selectModel.length
      client.send({ type: 'set-overlay', selection: { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' } })
      await waitFor(() => harness.calls.selectModel.length > selected)
      assert.equal(harness.calls.selectModel.at(-1)?.model, 'deepseek-pro')
      assert.equal(harness.calls.selectModel.at(-1)?.reasoningEffort, 'high')
      assert.equal(harness.calls.selectModel.at(-1)?.saveAsDefault, false)
      assert.equal(harness.calls.selectModel.at(-1)?.sessionId, session.sessionId)

      client.send({ type: 'set-background', selection: { provider: 'deepseek-official', model: 'background-model' } })
      await waitFor(() => harness.store.models().background.model === 'background-model')
      assert.equal(harness.calls.selectModel.every((call) => call.model !== 'background-model'), true)
      assert.equal(harness.store.models().overlay.model, 'deepseek-pro')

      const creates = harness.calls.create.length
      client.send({ type: 'set-selection', enabled: false })
      await waitFor(() => harness.store.selectionEnabled() === false)
      const selection = JSON.parse(readFileSync(join(harness.profile, 'selection-toolbar.json'), 'utf8')) as { enabled: boolean }
      assert.equal(selection.enabled, false)
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(harness.calls.create.length, creates)

      client.send({ type: 'set-millifraction', enabled: true })
      await waitFor(() => harness.calls.create.length === creates + 1)
      assert.equal(harness.store.millifractionEnabled(), true)
      assert.equal(harness.store.coordinateMode(), 'millifraction')
      assert.equal(harness.calls.create.at(-1)?.sessionId, undefined)
      assert.equal(harness.calls.create.at(-1)?.agentPreset, 'computer-use')
      const afterFraction = harness.calls.create.length
      client.send({ type: 'set-millifraction', enabled: true })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(harness.calls.create.length, afterFraction)

      const beforeChrome = client.messages.filter((message) => message.type === 'chrome').length
      client.send({ type: 'menu' })
      await waitFor(() => client.messages.filter((message) => message.type === 'chrome').length > beforeChrome)
      const chrome = client.messages.filter((message) => message.type === 'chrome').at(-1) as {
        overlay: { model: string }
        background: { model: string }
        selectionEnabled: boolean
        millifractionEnabled: boolean
        catalog: { groups: { id: string }[] }
      }
      assert.equal(chrome.overlay.model, 'deepseek-pro')
      assert.equal(chrome.background.model, 'background-model')
      assert.equal(chrome.selectionEnabled, false)
      assert.equal(chrome.millifractionEnabled, true)
      assert.equal(chrome.catalog.groups[0]?.id, 'deepseek-official')
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('cancels only the ball session, answers a question, and disables the helper', async () => {
    const harness = boot()
    harness.holdPrompt()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'stop' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(harness.calls.cancel.length, 0)

      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      const mark = client.messages.length
      client.send({ type: 'prompt', text: '看一下屏幕' })
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'turn' && message.running === true))
      client.send({ type: 'stop' })
      await waitFor(() => harness.calls.cancel.length === 1)
      assert.deepEqual(harness.calls.cancel, [{ sessionId }])
      assert.equal(harness.calls.prompt[0]?.sessionId, sessionId)
      harness.releasePrompt()

      const answered = harness.question({
        agent: { id: sessionId },
        questions: [{ id: 'q1', question: '继续？', options: [{ label: '好' }] }],
      }, async () => { throw new Error('deferred') })
      await waitFor(() => client.messages.some((message) => message.type === 'question'))
      const card = client.messages.find((message) => message.type === 'question') as { id: string }
      client.send({ type: 'question-answer', id: card.id, answers: [{ id: 'q1', selected: ['好'] }] })
      assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: ['好'] }] })

      let deferred = false
      await harness.question({
        agent: { id: 'session-other' },
        questions: [{ id: 'q2', question: '别的会话' }],
      }, async () => {
        deferred = true
        return { answers: [] }
      })
      assert.equal(deferred, true)

      const cancelled = harness.question({
        agent: { id: sessionId },
        questions: [{ id: 'q3', question: '取消？' }],
      }, async () => { throw new Error('deferred') })
      await waitFor(() => client.messages.filter((message) => message.type === 'question').length > 1)
      const second = client.messages.filter((message) => message.type === 'question').at(-1) as { id: string }
      client.send({ type: 'question-cancel', id: second.id })
      await assert.rejects(cancelled, (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'UserQuestionError')
        assert.equal((error as { code?: string }).code, 'ASK_CANCELLED')
        return true
      })

      const closed = once(client.socket, 'close')
      client.send({ type: 'disable' })
      await closed
      assert.equal(harness.store.ballEnabled(), false)
      assert.equal(JSON.parse(readFileSync(join(harness.profile, 'ball-enabled.json'), 'utf8')).enabled, false)
    } finally {
      harness.releasePrompt()
      client.socket.destroy()
      harness.runtime.halt()
    }
  })
})
