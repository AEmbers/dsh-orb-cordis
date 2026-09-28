/**
 * NDJSON control plane for the ball, plus the Computer Use session it talks to.
 * The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { resolveElectronBinary } from './electron-runtime.ts'

const require = createRequire(import.meta.url)

/** Host services the plugin injects. Shapes match the official 0.1.7-rc.2 controllers. */
export interface OrbContext {
  readonly webServer: { readonly port: number }
  readonly connection: { authenticatedUrl(baseUrl: string): string }
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
  }
  readonly sessions: {
    get(id: string): {
      snapshotEvents(): readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
    } | undefined
  }
  effect(execute: () => void | (() => void)): void
}

interface LineMessage {
  readonly type: 'line'
  readonly role: 'user' | 'assistant' | 'tool' | 'status'
  readonly text: string
}

/** One host lifetime of the ball: socket, helper process, and one Computer Use session. */
export class OrbRuntime {
  private readonly token = randomBytes(32).toString('hex')
  private readonly sessionFile = dshHomePath('dsh-orb', 'floating-session.json')
  private server: Server | undefined
  private port = 0
  private readonly sockets = new Set<Socket>()
  private readonly buffers = new Map<Socket, string>()
  private readonly lines: LineMessage[] = []
  private child: ChildProcess | undefined
  private binary = ''
  private failures = 0
  private stopped = false
  private sessionId: string | undefined
  private sessionError: string | undefined
  private creating: Promise<string> | undefined
  private watermark = 0
  private missingLogged = false
  private timer: ReturnType<typeof setInterval> | undefined
  private giveUp: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly ctx: OrbContext) {}

  /** Open the socket, prepare a session, and spawn the helper. */
  async start(): Promise<void> {
    if (this.stopped) return
    await this.listen()
    if (this.stopped) return
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
    if (this.stopped) return
    await mkdir(dshHomePath('dsh-orb', 'helper-data'), { recursive: true })
    this.launch()
  }

  /** Stop the helper and the socket. A later helper exit is not a crash. */
  stop(): void {
    this.stopped = true
    this.stopWatch()
    this.server?.close()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.killChild()
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
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.buffers.delete(socket)
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
    for (const line of this.lines) this.send(socket, line)
  }

  private async onPrompt(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    this.line('user', trimmed)
    if (this.sessionError && !this.sessionId) {
      this.line('status', this.sessionError)
      return
    }
    this.line('status', '正在执行')
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
      this.stopWatch()
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: prompt failed: ${message}`)
      this.line('status', message)
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
    const workspace = dshHomePath('dsh_orb')
    await mkdir(workspace, { recursive: true })
    const created = await this.ctx.workspaceController.create({ path: workspace })
    const workspaceId = created.workspace.workspaceId
    const saved = await readSavedSession(this.sessionFile)
    try {
      const session = await this.ctx.sessionController.create({
        workspaceId,
        agentPreset: 'computer-use',
        ...saved ? { sessionId: saved } : {},
      })
      return this.remember(session.sessionId)
    } catch (error) {
      if (!saved) throw error
      console.error('dsh-orb: saved session cannot be opened; creating a new one')
      await rm(this.sessionFile, { force: true })
      const session = await this.ctx.sessionController.create({
        workspaceId,
        agentPreset: 'computer-use',
      })
      return this.remember(session.sessionId)
    }
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
      this.line('status', '等待超时')
      this.stopWatch()
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
        this.consume(event.type, event.data)
      }
    } catch (error) {
      console.error(`dsh-orb: transcript read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private consume(type: string, data: unknown): void {
    if (type === 'tool/call') {
      const name = toolName(data)
      if (name) this.line('tool', name)
      return
    }
    if (type === 'assistant/message') {
      const text = assistantText(data)
      if (text) this.line('assistant', text)
      return
    }
    if (type === 'turn/end') {
      this.line('status', '完成')
      this.stopWatch()
    }
  }

  private line(role: LineMessage['role'], text: string): void {
    const message: LineMessage = { type: 'line', role, text: clip(text) }
    this.lines.push(message)
    if (this.lines.length > 200) this.lines.shift()
    this.broadcast(message)
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
    if (this.stopped || !this.binary) return
    const userData = dshHomePath('dsh-orb', 'helper-data')
    const env = {
      ...process.env,
      DSH_ORB_TOKEN: this.token,
      DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
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
        if (!line.trim() || line.includes(token)) continue
        console.error(`dsh-orb helper: ${line}`)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    let settled = false
    const fail = (reason: string) => {
      if (settled || this.stopped) return
      settled = true
      if (this.child === child) this.child = undefined
      this.failures += 1
      if (this.failures > 3) {
        console.error('dsh-orb: helper exited too many times; ball stays hidden')
        return
      }
      console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`)
      const timer = setTimeout(() => this.launch(), 500)
      timer.unref()
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

function assistantText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const message = (data as { message?: { content?: unknown } }).message
  return textFromContent(message?.content)
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (typeof part !== 'object' || part === null) return ''
    const record = part as { type?: unknown; text?: unknown }
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).filter(Boolean).join('\n')
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= 4000 ? trimmed : trimmed.slice(0, 4000)
}
