/**
 * Minimal floating ball. The official dsh process owns the session; this process only draws and forwards one socket.
 */

import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ballHtml } from './page.ts'

const socketAddress = process.env.DSH_ORB_SOCKET ?? ''
const token = process.env.DSH_ORB_TOKEN ?? ''

process.title = 'dsh-orb-helper'

if (!socketAddress || !token) {
  console.error('dsh-orb helper: socket environment is missing')
  process.exit(1)
}

if (process.platform === 'darwin') app.setActivationPolicy?.('accessory')

let win: BrowserWindow | undefined
let live: Socket | undefined
let sessionId: string | null = null
let quitting = false
let buffer = ''

app.on('before-quit', () => {
  quitting = true
  live?.destroy()
})
app.on('window-all-closed', () => {
  app.quit()
})

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  const pagePath = join(userData, 'ball.html')
  await writeFile(pagePath, ballHtml)
  win = openWindow()
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isVisible()) win.showInactive()
  })
  await win.loadFile(pagePath)
  connect(0)
})

ipcMain.handle('orb:session', () => sessionId)

ipcMain.on('orb:prompt', (_event, text) => {
  if (typeof text !== 'string' || !live) return
  live.write(`${JSON.stringify({ type: 'prompt', text })}\n`)
})

ipcMain.on('orb:move-by', (_event, delta) => {
  if (!win || !isDelta(delta)) return
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy))
})

ipcMain.on('orb:expand', (_event, expanded) => {
  if (!win || typeof expanded !== 'boolean') return
  const [x, y] = win.getPosition()
  const [width, height] = win.getSize()
  const right = x + width
  const bottom = y + height
  const nextWidth = expanded ? 340 : 72
  const nextHeight = expanded ? 480 : 72
  win.setBounds({
    x: Math.round(right - nextWidth),
    y: Math.round(bottom - nextHeight),
    width: nextWidth,
    height: nextHeight,
  })
})

function openWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea
  const width = 72
  const height = 72
  const created = new BrowserWindow({
    title: 'dsh-orb',
    x: area.x + area.width - width,
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    ...process.platform === 'darwin' ? { type: 'panel' } : {},
    webPreferences: {
      preload: fileURLToPath(new URL('../preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  created.setContentProtection(true)
  created.setAlwaysOnTop(true, 'screen-saver')
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  created.once('ready-to-show', () => {
    created.showInactive()
    created.setContentProtection(true)
    const [x, y] = created.getPosition()
    const [width, height] = created.getSize()
    console.error(`dsh-orb helper: ball ${x},${y} ${width}x${height}`)
  })
  return created
}

function connect(attempt: number): void {
  if (quitting) return
  const colon = socketAddress.lastIndexOf(':')
  const host = socketAddress.slice(0, colon)
  const port = Number(socketAddress.slice(colon + 1))
  const socket = createConnection({ host, port })
  socket.setEncoding('utf8')
  let opened = false
  socket.on('connect', () => {
    opened = true
    live = socket
    buffer = ''
    socket.write(`${JSON.stringify({ type: 'hello', token })}\n`)
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(part)
      } catch {
        continue
      }
      deliver(message)
    }
  })
  socket.on('error', () => {
    // close follows and decides whether to retry.
  })
  socket.on('close', () => {
    if (live === socket) live = undefined
    if (quitting) return
    if (opened) {
      app.quit()
      return
    }
    if (attempt >= 30) {
      console.error('dsh-orb helper: host socket did not open')
      app.exit(1)
      return
    }
    setTimeout(() => connect(attempt + 1), 300)
  })
}

function deliver(message: unknown): void {
  if (typeof message !== 'object' || message === null || !win) return
  const record = message as { type?: unknown; sessionId?: unknown; role?: unknown; text?: unknown }
  if (record.type === 'session' && typeof record.sessionId === 'string') {
    sessionId = record.sessionId
    win.webContents.send('orb:session', sessionId)
    return
  }
  if (record.type === 'line' && typeof record.role === 'string' && typeof record.text === 'string') {
    win.webContents.send('orb:line', { role: record.role, text: record.text })
  }
}

function isDelta(value: unknown): value is { dx: number; dy: number } {
  if (typeof value !== 'object' || value === null) return false
  const delta = value as { dx?: unknown; dy?: unknown }
  return typeof delta.dx === 'number' && typeof delta.dy === 'number'
    && Number.isFinite(delta.dx) && Number.isFinite(delta.dy)
    && Math.abs(delta.dx) <= 10_000 && Math.abs(delta.dy) <= 10_000
}
