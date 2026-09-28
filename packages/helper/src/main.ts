/**
 * Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
 */

import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { createConnection, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { FloatingPlacement, initialWindowBounds } from './geometry.ts'

const socketAddress = process.env.DSH_ORB_SOCKET ?? ''
const token = process.env.DSH_ORB_TOKEN ?? ''

process.title = 'dsh-orb-helper'

if (!socketAddress || !token) {
  console.error('dsh-orb helper: socket environment is missing')
  process.exit(1)
}

if (process.platform === 'darwin') app.setActivationPolicy?.('accessory')

let win: BrowserWindow | undefined
let placement: FloatingPlacement | undefined
let live: Socket | undefined
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
  win = openWindow()
  placement = new FloatingPlacement(win, (point) => {
    const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
    return { bounds: display.bounds, workArea: display.workArea }
  })
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isVisible()) win.showInactive()
  })
  await win.loadFile(fileURLToPath(new URL('../assets/floating.html', import.meta.url)))
  connect(0)
})

ipcMain.handle('orb:expand', (_event, expanded) => {
  if (!placement || typeof expanded !== 'boolean') return { expanded: false, horizontal: 'left', vertical: 'up', docked: undefined }
  return placement.setExpanded(expanded)
})

ipcMain.handle('orb:move', (_event, request) => {
  if (!placement || !isMove(request)) return { docked: undefined }
  return placement.move(request.x, request.y, request.canDock)
})

ipcMain.handle('orb:clamp', async (_event, canDock) => {
  if (!placement) return { docked: undefined }
  return placement.clamp(canDock !== false)
})

ipcMain.handle('orb:unsnap', async () => {
  if (!placement) return { docked: undefined }
  return placement.unsnap()
})

ipcMain.on('orb:prompt', (_event, text) => {
  write({ type: 'prompt', text })
})

ipcMain.on('orb:question-answer', (_event, payload) => {
  if (typeof payload !== 'object' || payload === null) return
  const record = payload as { id?: unknown; answers?: unknown }
  write({ type: 'question-answer', id: record.id, answers: record.answers })
})

ipcMain.on('orb:question-cancel', (_event, id) => {
  write({ type: 'question-cancel', id })
})

function openWindow(): BrowserWindow {
  const bounds = initialWindowBounds(screen.getPrimaryDisplay().workArea)
  const created = new BrowserWindow({
    title: 'dsh-orb',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
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
    roundedCorners: false,
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
  if (process.platform === 'darwin') {
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  created.once('ready-to-show', () => {
    created.showInactive()
    created.setContentProtection(true)
    const shown = created.getBounds()
    console.error(`dsh-orb helper: ball ${shown.x},${shown.y} ${shown.width}x${shown.height}`)
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
  const record = message as { type?: unknown }
  if (record.type === 'session') {
    win.webContents.send('orb:session', (record as { sessionId?: unknown }).sessionId)
    return
  }
  if (record.type === 'block') {
    win.webContents.send('orb:block', message)
    return
  }
  if (record.type === 'turn') {
    win.webContents.send('orb:turn', message)
    return
  }
  if (record.type === 'status') {
    win.webContents.send('orb:status', (record as { text?: unknown }).text)
    return
  }
  if (record.type === 'question') {
    win.webContents.send('orb:question', message)
    return
  }
  if (record.type === 'question-clear') {
    win.webContents.send('orb:question-clear', (record as { id?: unknown }).id)
    return
  }
  if (record.type === 'question-error') {
    win.webContents.send('orb:question-error', message)
  }
}

function write(message: unknown): void {
  if (!live) return
  live.write(`${JSON.stringify(message)}\n`)
}

function isMove(value: unknown): value is { x: number; y: number; canDock: boolean } {
  if (typeof value !== 'object' || value === null) return false
  const point = value as { x?: unknown; y?: unknown; canDock?: unknown }
  return typeof point.x === 'number' && typeof point.y === 'number'
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.abs(point.x) <= 100_000 && Math.abs(point.y) <= 100_000
    && typeof point.canDock === 'boolean'
}
