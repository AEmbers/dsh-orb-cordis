declare module 'electron' {
  interface Rectangle {
    x: number
    y: number
    width: number
    height: number
  }

  interface Display {
    workArea: Rectangle
  }

  interface WebContents {
    send(channel: string, ...args: unknown[]): void
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate' | 'did-finish-load', listener: (event: { preventDefault(): void }) => void): void
  }

  interface BrowserWindow {
    loadFile(path: string): Promise<void>
    setContentProtection(enable: boolean): void
    setAlwaysOnTop(flag: boolean, level?: string): void
    setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean }): void
    setBounds(bounds: Rectangle): void
    setPosition(x: number, y: number): void
    getPosition(): [number, number]
    getSize(): [number, number]
    isVisible(): boolean
    showInactive(): void
    once(event: 'ready-to-show', listener: () => void): void
    webContents: WebContents
  }

  interface BrowserWindowOptions {
    title?: string
    x?: number
    y?: number
    width?: number
    height?: number
    frame?: boolean
    transparent?: boolean
    alwaysOnTop?: boolean
    resizable?: boolean
    movable?: boolean
    minimizable?: boolean
    maximizable?: boolean
    fullscreenable?: boolean
    skipTaskbar?: boolean
    hasShadow?: boolean
    focusable?: boolean
    show?: boolean
    backgroundColor?: string
    type?: string
    webPreferences?: {
      preload?: string
      contextIsolation?: boolean
      nodeIntegration?: boolean
      sandbox?: boolean
    }
  }

  export const BrowserWindow: new (options: BrowserWindowOptions) => BrowserWindow

  export const app: {
    whenReady(): Promise<void>
    quit(): void
    exit(code: number): void
    getPath(name: 'userData'): string
    setActivationPolicy?(policy: 'accessory'): void
    dock?: { hide(): void }
    on(event: 'before-quit' | 'window-all-closed', listener: () => void): void
  }

  export const screen: {
    getPrimaryDisplay(): Display
  }

  export const ipcMain: {
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
    handle(channel: string, listener: () => unknown): void
  }
}
