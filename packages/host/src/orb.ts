/**
 * NDJSON control plane for the ball, plus the Computer Use session it talks to.
 * The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { normalizeCatalog } from './catalog.ts'
import { resolveElectronBinary } from './electron-runtime.ts'
import { openMainWindow } from './open-main.ts'
import {
  isAgentModelSelection,
  isPermissionPreset,
  type AgentModelSelection,
  type PermissionPreset,
  type ProfileStore,
} from './preferences.ts'
import { tokensMatch } from './routes.ts'
import { pinSessionId } from './services.ts'

const require = createRequire(import.meta.url)

/** Host services the plugin injects. Shapes match the official 0.1.7-rc.2 controllers. */
export interface OrbContext {
  readonly webServer: {
    readonly port: number
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
    }): () => void
  }
  readonly connection: {
    authenticatedUrl(baseUrl: string): string
    admit?(request: import('node:http').IncomingMessage): { rejection?: number } | { peer?: unknown }
    isAuthenticated?(request: import('node:http').IncomingMessage): boolean
  }
  readonly workspaceController: {
    create(request: { readonly path: string }): Promise<{
      readonly workspace: { readonly workspaceId: string }
    }>
  }
  readonly sessionController: {
    create(request: {
      readonly workspaceId?: string
      readonly sessionId?: string
      readonly agentPreset?: string
    }): Promise<{ readonly sessionId: string }>
    prompt(request: {
      readonly requestId: string
      readonly sessionId: string
      readonly mode: 'queue' | 'steer'
      readonly content: readonly { readonly type: 'text'; readonly text: string }[]
      readonly clientTimeZone?: string
    }, signal: AbortSignal): Promise<{ readonly accepted: true }>
    list(request: object, signal: AbortSignal): Promise<{ readonly items?: readonly unknown[] } | readonly unknown[]>
    selectModel(request: {
      readonly sessionId: string
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
      readonly saveAsDefault: boolean
    }): Promise<unknown>
    cancel(request: { readonly sessionId: string }): Promise<unknown>
    modelCatalog(): unknown
  }
  readonly sessions: {
    get(id: string): {
      snapshotEvents(): readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
      readonly header?: { readonly cwd?: string; readonly agentPreset?: string }
    } | undefined
  }
  effect(execute: () => void | (() => void)): void
  get(name: string): unknown
  provide(name: string, value: unknown): void
  on(
    name: 'user-questions/request',
    listener: (
      request: QuestionRequest,
      next: () => Promise<QuestionAnswer>,
    ) => Promise<QuestionAnswer>,
    options?: { readonly prepend?: boolean },
  ): (() => void) | void
  on(
    name: 'session/created',
    listener: (session: { readonly header?: { readonly cwd?: string; readonly agentPreset?: string } }) => void,
  ): (() => void) | void
}

interface QuestionRequest {
  readonly questions?: unknown
  readonly agent?: { readonly id?: unknown }
  readonly signal?: AbortSignal
}

interface QuestionAnswer {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}

interface BlockMessage {
  readonly type: 'block'
  readonly key: string
  readonly kind: 'user' | 'reasoning' | 'assistant' | 'tool'
  readonly text: string
  readonly running: boolean
}

interface PendingQuestion {
  readonly id: string
  readonly resolve: (answer: QuestionAnswer) => void
  readonly reject: (error: Error) => void
}

interface ShownQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: true
}

/** One host lifetime of the ball: socket, helper process, and one Computer Use session. */
export class OrbRuntime {
  private readonly token = randomBytes(32).toString('hex')
  private readonly sessionFile = dshHomePath('dsh-orb', 'floating-session.json')
  private server: Server | undefined
  private port = 0
  private readonly sockets = new Set<Socket>()
  private readonly buffers = new Map<Socket, string>()
  private readonly blocks = new Map<string, BlockMessage>()
  private readonly blockOrder: string[] = []
  private pending: PendingQuestion | undefined
  private questionBody: readonly ShownQuestion[] | undefined
  private turnRunning = false
  private child: ChildProcess | undefined
  private binary = ''
  private failures = 0
  private halted = false
  private generation = 0
  private replaying = false
  private workspaceTask: Promise<string> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private opening = false
  private sessionId: string | undefined
  private sessionError: string | undefined
  private creating: Promise<string> | undefined
  private watermark = 0
  private missingLogged = false
  private timer: ReturnType<typeof setInterval> | undefined
  private giveUp: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly ctx: OrbContext, private readonly store: ProfileStore) {}

  /** Open the socket, prepare a session, and spawn the helper. A halted ball can start again. */
  async start(): Promise<void> {
    if (process.platform === 'linux') return
    if (this.opening || (!this.halted && this.server)) return
    this.opening = true
    this.halted = false
    this.failures = 0
    this.generation += 1
    const generation = this.generation
    try {
      await this.begin(generation)
    } finally {
      this.opening = false
    }
  }

  private async begin(generation: number): Promise<void> {
    await this.listen()
    if (this.halted || generation !== this.generation) {
      this.server?.close()
      this.server = undefined
      return
    }
    console.error(`dsh-orb: helper socket 127.0.0.1:${this.port}`)
    const sessionTask = this.ensureSession().catch((error: unknown) => {
      this.sessionError = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: session setup failed: ${this.sessionError}`)
    })
    try {
      this.binary = await resolveElectronBinary()
    } catch (error) {
      console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    await sessionTask
    if (this.halted || generation !== this.generation) return
    await mkdir(dshHomePath('dsh-orb', 'helper-data'), { recursive: true })
    this.launch()
  }

  /**
   * Open the control socket without spawning the helper.
   * {@link start} listens and then launches the helper process.
   */
  async bind(): Promise<{ port: number; token: string }> {
    if (!this.server) await this.listen()
    return { port: this.port, token: this.token }
  }

  /** Stop the helper and the socket. Settings can call {@link start} again. */
  halt(): void {
    this.generation += 1
    this.halted = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.stopWatch()
    this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    this.server?.close()
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.buffers.clear()
    this.killChild()
  }

  /** Claim questions for this orb session. Register this while the plugin fiber is active. */
  attachQuestions(): () => void {
    try {
      const dispose = this.ctx.on(
        'user-questions/request',
        (request, next) => this.onQuestion(request, next),
        { prepend: true },
      )
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      console.error(`dsh-orb: question listener failed: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }

  private async listen(): Promise<void> {
    const server = createServer((socket) => {
      this.handle(socket)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('dsh-orb: helper socket has no port')
    this.port = address.port
  }

  private handle(socket: Socket): void {
    socket.setEncoding('utf8')
    let authed = false
    const timer = setTimeout(() => {
      if (!authed) socket.destroy()
    }, 3000)
    timer.unref()
    socket.on('data', (chunk: string) => {
      const next = `${this.buffers.get(socket) ?? ''}${chunk}`
      if (next.length > 1_000_000) {
        socket.destroy()
        return
      }
      const parts = next.split('\n')
      this.buffers.set(socket, parts.pop() ?? '')
      for (const part of parts) {
        if (!part.trim()) continue
        let message: unknown
        try {
          message = JSON.parse(part)
        } catch {
          socket.destroy()
          return
        }
        if (!authed) {
          if (!this.helloOk(message)) {
            socket.destroy()
            return
          }
          authed = true
          clearTimeout(timer)
          this.accept(socket)
          continue
        }
        if (isPrompt(message)) void this.onPrompt(message.text)
        else if (isQuestionAnswer(message)) this.onQuestionAnswer(message.id, message.answers)
        else if (isQuestionCancel(message)) this.onQuestionCancel(message.id)
        else this.onControl(message)
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.buffers.delete(socket)
      if (this.sockets.size === 0) this.failQuestion('the floating ball closed before the user answered', 'ASK_ABORTED')
    })
    socket.on('error', () => {
      socket.destroy()
    })
  }

  private helloOk(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false
    const record = message as { type?: unknown; token?: unknown }
    if (record.type !== 'hello' || typeof record.token !== 'string') return false
    const given = Buffer.from(record.token)
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    if (this.sessionId) this.send(socket, { type: 'session', sessionId: this.sessionId })
    if (this.blockOrder.length === 0 && this.sessionId) {
      this.replaying = true
      this.drain()
      this.replaying = false
    } else {
      for (const key of this.blockOrder) {
        const block = this.blocks.get(key)
        if (block) this.send(socket, block)
      }
    }
    this.send(socket, { type: 'turn', running: this.turnRunning })
    if (this.pending) this.send(socket, this.questionPayload(this.pending.id))
    void this.publishChrome()
  }

  private async onPrompt(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    this.block(`user:${randomUUID()}`, 'user', trimmed, false, 'set')
    this.turnRunning = true
    this.broadcast({ type: 'turn', running: true })
    if (this.sessionError && !this.sessionId) {
      this.turnRunning = false
      this.broadcast({ type: 'turn', running: false })
      this.status(this.sessionError)
      return
    }
    try {
      const sessionId = await this.ensureSession()
      if (!this.timer) this.syncWatermark()
      this.watch()
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: trimmed }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, new AbortController().signal)
      this.drain()
    } catch (error) {
      this.finishTurn()
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: prompt failed: ${message}`)
      this.status(message)
    }
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId
    this.creating ??= this.createSession().finally(() => {
      this.creating = undefined
    })
    return this.creating
  }

  private async createSession(): Promise<string> {
    const workspaceId = await this.workspaceId()
    const saved = await readSavedSession(this.sessionFile)
    try {
      const session = await this.ctx.sessionController.create({
        workspaceId,
        agentPreset: 'computer-use',
        ...saved ? { sessionId: saved } : {},
      })
      return this.adopt(session.sessionId)
    } catch (error) {
      if (!saved) throw error
      console.error('dsh-orb: saved session cannot be opened; creating a new one')
      await rm(this.sessionFile, { force: true })
      const session = await this.ctx.sessionController.create({
        workspaceId,
        agentPreset: 'computer-use',
      })
      return this.adopt(session.sessionId)
    }
  }

  private workspaceId(): Promise<string> {
    this.workspaceTask ??= this.createWorkspace().catch((error: unknown) => {
      this.workspaceTask = undefined
      throw error
    })
    return this.workspaceTask
  }

  private async createWorkspace(): Promise<string> {
    const workspace = dshHomePath('dsh_orb')
    await mkdir(workspace, { recursive: true })
    const created = await this.ctx.workspaceController.create({ path: workspace })
    return created.workspace.workspaceId
  }

  private async adopt(sessionId: string): Promise<string> {
    const id = await this.remember(sessionId)
    await this.applyOverlayQuiet(id)
    pinSessionId(this.ctx, id, this.store.permission())
    return id
  }

  private async remember(sessionId: string): Promise<string> {
    this.sessionId = sessionId
    this.sessionError = undefined
    try {
      await mkdir(dirname(this.sessionFile), { recursive: true })
      await writeFile(this.sessionFile, `${JSON.stringify({ sessionId })}\n`)
    } catch (error) {
      console.error(`dsh-orb: could not save session id: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.broadcast({ type: 'session', sessionId })
    console.error(`dsh-orb: session ${sessionId}`)
    return sessionId
  }

  private syncWatermark(): void {
    if (!this.sessionId) return
    const session = this.ctx.sessions.get(this.sessionId)
    if (!session) return
    for (const event of session.snapshotEvents()) {
      const seq = Number(event.seq)
      if (seq > this.watermark) this.watermark = seq
    }
  }

  private watch(): void {
    if (!this.timer) this.timer = setInterval(() => this.drain(), 400)
    if (this.giveUp) clearTimeout(this.giveUp)
    this.giveUp = setTimeout(() => {
      if (this.pending) {
        this.watch()
        return
      }
      this.status('等待超时')
      this.finishTurn()
    }, 180_000)
  }

  private stopWatch(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.giveUp) clearTimeout(this.giveUp)
    this.giveUp = undefined
  }

  private drain(): void {
    if (!this.sessionId) return
    const session = this.ctx.sessions.get(this.sessionId)
    if (!session) {
      if (!this.missingLogged) {
        this.missingLogged = true
        console.error('dsh-orb: session is not in the store yet')
      }
      return
    }
    this.missingLogged = false
    try {
      for (const event of session.snapshotEvents()) {
        const seq = Number(event.seq)
        if (seq <= this.watermark) continue
        this.watermark = seq
        this.consume(event.type, event.data, seq)
      }
    } catch (error) {
      console.error(`dsh-orb: transcript read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private consume(type: string, data: unknown, seq: number): void {
    if (type === 'user/message') {
      if (!this.replaying) return
      const text = userText(data)
      if (!text.trim()) return
      this.block(`user:${seq}`, 'user', text, false, 'set')
      return
    }
    if (type === 'assistant/chunk') {
      this.onChunk(data)
      return
    }
    if (type === 'assistant/message') {
      this.onAssistant(data)
      return
    }
    if (type === 'tool/call') {
      const name = toolName(data)
      if (!name) return
      const id = callId(data)
      const existing = id ? undefined : this.runningTool(name)
      this.block(id ? `tool:${id}` : existing ?? `tool:${seq}`, 'tool', name, false, 'set')
      return
    }
    if (type === 'turn/end') this.finishTurn()
  }

  private onChunk(data: unknown): void {
    const record = asRecord(data)
    const chunk = asRecord(record?.chunk)
    if (!record || !chunk) return
    const turn = numberOf(record.turn)
    const step = numberOf(record.step)
    const index = numberOf(chunk.index)
    const key = `b:${turn}:${step}:${index}`
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      this.block(key, 'assistant', chunk.text, true, 'append')
      return
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      this.block(key, 'reasoning', chunk.text, true, 'append')
      return
    }
    if (chunk.type === 'tool-call-delta') {
      const name = typeof chunk.name === 'string' ? chunk.name : ''
      if (!name) return
      const id = typeof chunk.id === 'string' ? chunk.id : ''
      this.block(id ? `tool:${id}` : key, 'tool', name, true, 'set')
      return
    }
    if (chunk.type === 'block-end') this.applyContent(key, chunk.block, turn, step, index, false)
  }

  private onAssistant(data: unknown): void {
    const record = asRecord(data)
    if (!record) return
    const turn = numberOf(record.turn)
    const step = numberOf(record.step)
    if (Array.isArray(record.stream)) {
      for (const item of record.stream) this.foldStream(item, turn, step)
    }
    const message = asRecord(record.message)
    const content = message?.content
    if (typeof content === 'string') {
      this.block(`b:${turn}:${step}:0`, 'assistant', content, false, 'set')
      return
    }
    if (!Array.isArray(content)) return
    content.forEach((part, index) => {
      this.applyContent(`b:${turn}:${step}:${index}`, part, turn, step, index, false)
    })
  }

  private foldStream(item: unknown, turn: number, step: number): void {
    const record = asRecord(item)
    if (!record) return
    if (record.type === 'chunk') {
      this.onChunk({ turn, step, chunk: record.chunk })
      return
    }
    const index = numberOf(record.index)
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      const texts = Array.isArray(record.texts) ? record.texts.filter((part): part is string => typeof part === 'string').join('') : ''
      if (!texts.trim()) return
      this.block(`b:${turn}:${step}:${index}`, record.type === 'reasoning-chunks' ? 'reasoning' : 'assistant', texts, false, 'set')
      return
    }
    if (record.type !== 'tool-call-chunks') return
    const name = typeof record.name === 'string' ? record.name : ''
    if (!name || this.hasTool(name)) return
    const id = typeof record.id === 'string' ? record.id : ''
    this.block(id ? `tool:${id}` : `b:${turn}:${step}:${index}`, 'tool', name, false, 'set')
  }

  private applyContent(key: string, part: unknown, turn: number, step: number, index: number, running: boolean): void {
    const block = asRecord(part)
    if (!block) return
    if ((block.type === 'text' || block.type === 'reasoning' || block.type === 'thinking') && typeof block.text === 'string') {
      if (!block.text.trim()) return
      const kind = block.type === 'text' ? 'assistant' : 'reasoning'
      this.block(key, kind, block.text, running, 'set')
      return
    }
    if (block.type !== 'tool-call' && block.type !== 'tool_use') return
    const name = typeof block.name === 'string' ? block.name : ''
    if (!name || this.hasTool(name)) return
    const id = typeof block.id === 'string' ? block.id : typeof block.callId === 'string' ? block.callId : ''
    this.block(id ? `tool:${id}` : `b:${turn}:${step}:${index}`, 'tool', name, running, 'set')
  }

  private hasTool(name: string): boolean {
    for (const block of this.blocks.values()) {
      if (block.kind === 'tool' && block.text === name) return true
    }
    return false
  }

  private runningTool(name: string): string | undefined {
    for (const key of this.blockOrder) {
      const block = this.blocks.get(key)
      if (block?.kind === 'tool' && block.text === name && block.running) return key
    }
    return undefined
  }

  private finishTurn(): void {
    this.turnRunning = false
    for (const key of [...this.blockOrder]) {
      const item = this.blocks.get(key)
      if (item?.running) this.block(key, item.kind, item.text, false, 'set')
    }
    this.broadcast({ type: 'turn', running: false })
    this.stopWatch()
    const reply = [...this.blockOrder].reverse().map((key) => this.blocks.get(key)).find((item) => item?.kind === 'assistant')
    console.error(`dsh-orb: turn done reply=${reply?.text.length ?? 0}`)
  }

  private block(
    key: string,
    kind: BlockMessage['kind'],
    text: string,
    running: boolean,
    mode: 'set' | 'append',
  ): void {
    const previous = this.blocks.get(key)?.text ?? ''
    const next = clip(mode === 'append' ? `${previous}${text}` : text, 20_000)
    if (!next.trim()) return
    const message: BlockMessage = { type: 'block', key, kind, text: next, running }
    if (!this.blocks.has(key)) {
      this.blockOrder.push(key)
      while (this.blockOrder.length > 200) {
        const dropped = this.blockOrder.shift()
        if (dropped) this.blocks.delete(dropped)
      }
    }
    this.blocks.set(key, message)
    this.broadcast(message)
  }

  private status(text: string): void {
    this.broadcast({ type: 'status', text: clip(text, 500) })
  }

  private onQuestion(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    const agentId = typeof request.agent?.id === 'string' ? request.agent.id : ''
    const questions = sanitizeQuestions(request.questions)
    if (this.sockets.size === 0 || !this.sessionId || agentId !== this.sessionId || this.pending || questions.length === 0) {
      if (this.sessionId && agentId === this.sessionId) {
        console.error(`dsh-orb: question deferred sockets=${this.sockets.size} pending=${this.pending !== undefined} count=${questions.length}`)
      }
      return next()
    }
    console.error(`dsh-orb: question card ${questions.length}`)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject }
      this.questionBody = questions
      this.broadcast(this.questionPayload(id))
      const signal = request.signal
      const onAbort = () => {
        this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED', id)
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private onQuestionAnswer(id: string, answers: unknown): void {
    const pending = this.pending
    if (!pending || pending.id !== id) return
    const parsed = parseAnswers(answers)
    if (!parsed) {
      this.broadcast({ type: 'question-error', id, text: '答案无效' })
      return
    }
    this.pending = undefined
    this.questionBody = undefined
    this.broadcast({ type: 'question-clear', id })
    console.error('dsh-orb: question answered')
    pending.resolve(parsed)
  }

  private onQuestionCancel(id: string): void {
    this.failQuestion('the user cancelled ask_user_question', 'ASK_CANCELLED', id)
  }

  private failQuestion(message: string, code: string, id = this.pending?.id): void {
    const pending = this.pending
    if (!pending || pending.id !== id) return
    this.pending = undefined
    this.questionBody = undefined
    this.broadcast({ type: 'question-clear', id })
    console.error(`dsh-orb: question ${code}`)
    pending.reject(questionError(message, code))
  }

  private questionPayload(id: string): { type: 'question'; id: string; questions: readonly ShownQuestion[] } {
    return { type: 'question', id, questions: this.questionBody ?? [] }
  }

  private broadcast(message: unknown): void {
    for (const socket of this.sockets) this.send(socket, message)
  }

  private send(socket: Socket, message: unknown): void {
    try {
      socket.write(`${JSON.stringify(message)}\n`)
    } catch {
      socket.destroy()
    }
  }

  private launch(): void {
    if (this.halted || !this.binary) return
    const generation = this.generation
    const userData = dshHomePath('dsh-orb', 'helper-data')
    const env = {
      ...process.env,
      DSH_ORB_TOKEN: this.token,
      DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
      DSH_ORB_WEB_PORT: String(this.ctx.webServer.port),
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(this.binary, [`--user-data-dir=${userData}`, helperMain()], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    console.error(`dsh-orb: helper started pid ${child.pid ?? 'unknown'}`)
    const token = this.token
    const log = (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim() || line.includes(token) || /token=|api[_-]?key|authorization/i.test(line)) continue
        console.error(`dsh-orb helper: ${line}`)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    let settled = false
    const fail = (reason: string) => {
      if (settled || this.halted || generation !== this.generation) return
      settled = true
      if (this.child === child) this.child = undefined
      this.failures += 1
      if (this.failures > 3) {
        console.error('dsh-orb: helper exited too many times; ball stays hidden')
        return
      }
      console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`)
      this.retry = setTimeout(() => this.launch(), 500)
      this.retry.unref()
    }
    child.once('error', (error) => fail(error.message))
    child.once('exit', (code, signal) => fail(String(code ?? signal)))
  }

  private killChild(): void {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const pid = child.pid
    if (pid === undefined) return
    const timer = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The helper already exited.
      }
    }, 1000)
    timer.unref()
  }

  /** True when the helper presented this socket token. */
  helperAuthorized(token: string): boolean {
    return tokensMatch(token, this.token)
  }

  /** Push permission, both models, the catalog, and the avatar version to the ball. */
  async publishChrome(): Promise<void> {
    const models = this.store.models()
    let catalog = { groups: [] as readonly { id: string; name: string; models: readonly unknown[] }[] }
    try {
      catalog = normalizeCatalog(await this.ctx.sessionController.modelCatalog())
    } catch (error) {
      console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.broadcast({ type: 'permission', preset: this.store.permission() })
    this.broadcast({
      type: 'chrome',
      overlay: models.overlay,
      background: models.background,
      selectionEnabled: this.store.selectionEnabled(),
      millifractionEnabled: this.store.millifractionEnabled(),
      catalog,
    })
    this.broadcast({ type: 'avatar', version: Math.trunc(this.store.avatarVersion()) })
  }

  async setOverlayModel(selection: AgentModelSelection): Promise<void> {
    this.store.setOverlay(selection)
    if (this.sessionId) await this.applyOverlayQuiet(this.sessionId)
    await this.publishChrome()
  }

  async setBackgroundModel(selection: AgentModelSelection): Promise<void> {
    this.store.setBackground(selection)
    await this.publishChrome()
  }

  async setSelectionEnabled(enabled: boolean): Promise<void> {
    this.store.setSelectionEnabled(enabled)
    await this.publishChrome()
  }

  async setMillifractionEnabled(enabled: boolean): Promise<void> {
    if (this.store.millifractionEnabled() === enabled) return
    this.store.setMillifractionEnabled(enabled)
    if (this.sessionId) await this.newSession()
    else await this.publishChrome()
  }

  async setBallEnabled(enabled: boolean): Promise<void> {
    this.store.setBallEnabled(enabled)
    if (process.platform === 'linux') return
    if (enabled) await this.start()
    else this.halt()
  }

  private onControl(message: unknown): void {
    const record = asRecord(message)
    if (!record || typeof record.type !== 'string') return
    if (record.type === 'history') {
      void this.sendHistory()
      return
    }
    if (record.type === 'open' && typeof record.sessionId === 'string') {
      void this.openSession(record.sessionId)
      return
    }
    if (record.type === 'new') {
      void this.newSession()
      return
    }
    if (record.type === 'permission' && isPermissionPreset(record.preset)) {
      void this.setPermission(record.preset)
      return
    }
    if (record.type === 'stop') {
      void this.stopTurn()
      return
    }
    if (record.type === 'menu') {
      void this.publishChrome()
      return
    }
    if (record.type === 'set-overlay' && isAgentModelSelection(record.selection)) {
      void this.setOverlayModel(record.selection)
      return
    }
    if (record.type === 'set-background' && isAgentModelSelection(record.selection)) {
      void this.setBackgroundModel(record.selection)
      return
    }
    if (record.type === 'set-selection' && typeof record.enabled === 'boolean') {
      void this.setSelectionEnabled(record.enabled)
      return
    }
    if (record.type === 'set-millifraction' && typeof record.enabled === 'boolean') {
      void this.setMillifractionEnabled(record.enabled)
      return
    }
    if (record.type === 'disable') {
      void this.setBallEnabled(false)
      return
    }
    if (record.type === 'open-main') void this.openMain()
  }

  private async setPermission(preset: PermissionPreset): Promise<void> {
    this.store.setPermission(preset)
    if (this.sessionId) pinSessionId(this.ctx, this.sessionId, preset)
    await this.publishChrome()
  }

  private async stopTurn(): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId || !this.turnRunning) return
    try {
      await this.ctx.sessionController.cancel({ sessionId })
    } catch (error) {
      console.error(`dsh-orb: cancel failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.drain()
    this.finishTurn()
  }

  private async newSession(): Promise<void> {
    this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    const session = await this.ctx.sessionController.create({
      workspaceId: await this.workspaceId(),
      agentPreset: 'computer-use',
    })
    await this.adopt(session.sessionId)
    this.resetTranscript()
    await this.publishChrome()
  }

  private async openSession(sessionId: string): Promise<void> {
    if (!sessionId.startsWith('session-') || sessionId.length > 80) return
    const rows = await this.historyRecords()
    const row = rows.find((item) => item.sessionId === sessionId)
    if (!row) return
    this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    const session = await this.ctx.sessionController.create({
      workspaceId: await this.workspaceId(),
      agentPreset: 'computer-use',
      sessionId,
    })
    await this.adopt(session.sessionId)
    this.resetTranscript()
    this.replaying = true
    this.drain()
    this.replaying = false
    if (row.running) {
      this.turnRunning = true
      this.broadcast({ type: 'turn', running: true })
      this.watch()
    }
  }

  private async sendHistory(): Promise<void> {
    const current = this.sessionId
    const items = (await this.historyRecords()).slice(0, 40).map((row) => ({
      sessionId: row.sessionId,
      title: row.title,
      current: row.sessionId === current,
    }))
    this.broadcast({ type: 'history', items })
  }

  private async historyRecords(): Promise<{ sessionId: string; title: string; running: boolean }[]> {
    try {
      const listed = await this.ctx.sessionController.list({}, AbortSignal.timeout(15_000))
      const rows = Array.isArray(listed) ? listed : listed.items ?? []
      const orb = resolve(dshHomePath('dsh_orb'))
      const items: { sessionId: string; title: string; running: boolean }[] = []
      for (const row of rows) {
        const record = asRecord(row)
        if (!record || !isHistoryRow(record, orb) || typeof record.sessionId !== 'string') continue
        const title = projection(record, 'title')
        items.push({
          sessionId: record.sessionId,
          title: typeof title === 'string' ? title.slice(0, 200) : '',
          running: record.running === true,
        })
      }
      return items
    } catch (error) {
      console.error(`dsh-orb: history failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private resetTranscript(): void {
    this.blocks.clear()
    this.blockOrder.length = 0
    this.watermark = 0
    this.turnRunning = false
    this.stopWatch()
    this.broadcast({ type: 'reset' })
    this.broadcast({ type: 'turn', running: false })
  }

  private async applyOverlayQuiet(sessionId: string): Promise<void> {
    const selection = this.store.models().overlay
    try {
      await this.ctx.sessionController.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        saveAsDefault: false,
      })
    } catch (error) {
      console.error(`dsh-orb: overlay model failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private openMain(): void {
    void openMainWindow(this.ctx).catch(() => {
      console.error('dsh-orb: could not open the main window')
    })
  }
}

function helperMain(): string {
  const pkg = require.resolve('@dsh-orb/helper/package.json')
  return join(dirname(pkg), 'lib', 'main.js')
}

function isPrompt(message: unknown): message is { type: 'prompt'; text: string } {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { type?: unknown; text?: unknown }
  return record.type === 'prompt' && typeof record.text === 'string' && record.text.length <= 8000
}

async function readSavedSession(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { sessionId?: unknown }
    if (typeof parsed.sessionId === 'string' && parsed.sessionId.startsWith('session-')) return parsed.sessionId
  } catch {
    // No saved session yet, or the file is unreadable. A new session is created.
  }
  return undefined
}

function toolName(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const name = (data as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

function isQuestionAnswer(message: unknown): message is { type: 'question-answer'; id: string; answers: unknown } {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { type?: unknown; id?: unknown }
  return record.type === 'question-answer' && typeof record.id === 'string'
}

function isQuestionCancel(message: unknown): message is { type: 'question-cancel'; id: string } {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { type?: unknown; id?: unknown }
  return record.type === 'question-cancel' && typeof record.id === 'string'
}

function isHistoryRow(record: Record<string, unknown>, orb: string): boolean {
  if (record.origin === 'subagent') return false
  if (typeof record.cwd !== 'string' || resolve(record.cwd) !== orb) return false
  const preset = projection(record, 'agentPreset')
  return preset === undefined || preset === 'computer-use'
}

function projection(record: Record<string, unknown>, key: string): unknown {
  const values = asRecord(asRecord(record.projections)?.values)
  return values?.[key]
}

function userText(data: unknown): string {
  const record = asRecord(data)
  if (!record) return ''
  const source = asRecord(record.source)
  if (source && source.kind !== undefined && source.kind !== 'user') return ''
  return textOf(record.content)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function callId(data: unknown): string {
  const record = asRecord(data)
  if (!record) return ''
  if (typeof record.id === 'string') return record.id
  if (typeof record.callId === 'string') return record.callId
  if (typeof record.toolCallId === 'string') return record.toolCallId
  const call = asRecord(record.call)
  return typeof call?.id === 'string' ? call.id : ''
}

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : ''
}

function sanitizeQuestions(value: unknown): ShownQuestion[] {
  if (!Array.isArray(value)) return []
  const questions: ShownQuestion[] = []
  for (const item of value.slice(0, 20)) {
    const record = asRecord(item)
    if (!record) continue
    const id = bounded(record.id, 200)
    const question = bounded(record.question, 4000)
    if (!id || !question) continue
    const options: { label: string; description?: string }[] = []
    if (Array.isArray(record.options)) {
      for (const option of record.options.slice(0, 20)) {
        const entry = asRecord(option)
        const label = entry ? bounded(entry.label, 500) : ''
        if (!label) continue
        const description = entry ? bounded(entry.description, 2000) : ''
        options.push(description ? { label, description } : { label })
      }
    }
    const detail = bounded(record.detail, 8000)
    const header = bounded(record.header, 200)
    questions.push({
      id,
      question,
      ...detail ? { detail } : {},
      ...header ? { header } : {},
      ...options.length > 0 ? { options } : {},
      ...record.multiSelect === true ? { multiSelect: true as const } : {},
    })
  }
  return questions
}

function parseAnswers(value: unknown): QuestionAnswer | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return undefined
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record || typeof record.id !== 'string' || record.id.length > 200) return undefined
    if (!Array.isArray(record.selected) || record.selected.length > 20) return undefined
    const selected: string[] = []
    for (const label of record.selected) {
      if (typeof label !== 'string' || label.length > 4000) return undefined
      selected.push(label)
    }
    if (record.custom !== undefined && (typeof record.custom !== 'string' || record.custom.length > 4000)) return undefined
    const custom = typeof record.custom === 'string' ? record.custom : ''
    answers.push({ id: record.id, selected, ...custom ? { custom } : {} })
  }
  return { answers }
}

function questionError(message: string, code: string): Error {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  return Object.assign(error, { code })
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}
