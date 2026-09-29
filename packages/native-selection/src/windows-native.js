/** Low-level Win32 mouse and keyboard hooks plus UI Automation selection reads. */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const WH_KEYBOARD_LL = 13
const WH_MOUSE_LL = 14
const WM_KEYDOWN = 0x0100
const WM_SYSKEYDOWN = 0x0104
const WM_LBUTTONDOWN = 0x0201
const WM_LBUTTONUP = 0x0202
const WM_RBUTTONDOWN = 0x0204
const WM_RBUTTONUP = 0x0205
const WM_MBUTTONDOWN = 0x0207
const WM_MBUTTONUP = 0x0208
const WM_MOUSEWHEEL = 0x020A
const MONITOR_DEFAULTTONEAREST = 2

const SELECTION_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) { return }
$pattern = $null
if (-not $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { return }
$ranges = @($pattern.GetSelection())
if ($ranges.Length -lt 1) { return }
$text = $ranges[0].GetText(4000)
if ([string]::IsNullOrWhiteSpace($text)) { return }
$rects = @($ranges[0].GetBoundingRectangles())
$x = 0; $y = 0; $width = 0; $height = 0
if ($rects.Length -ge 4) { $x = $rects[0]; $y = $rects[1]; $width = $rects[2]; $height = $rects[3] }
[pscustomobject]@{
  text = $text; x = $x; y = $y; width = $width; height = $height; pid = $focused.Current.ProcessId
} | ConvertTo-Json -Compress
`

function koffi() {
  return require('koffi')
}

let prepared = false
let activationApi

function prepareKoffi() {
  const lib = koffi()
  if (prepared) return lib
  lib.struct('DSH_ORB_SEL_POINT', { x: 'int32', y: 'int32' })
  lib.struct('DSH_ORB_SEL_MSLL', {
    pt: 'DSH_ORB_SEL_POINT',
    mouseData: 'uint32',
    flags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  })
  lib.proto('int __stdcall DshOrbSelEnumProc(void *hwnd, intptr lParam)')
  lib.proto('intptr __stdcall DshOrbSelHookProc(int nCode, uintptr wParam, intptr lParam)')
  prepared = true
  return lib
}

function windowsActivationApi() {
  if (activationApi !== undefined) return activationApi
  const lib = prepareKoffi()
  const user32 = lib.load('user32.dll')
  activationApi = {
    SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(void *hWnd)'),
    IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hWnd)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)'),
    EnumWindows: user32.func('int __stdcall EnumWindows(DshOrbSelEnumProc *cb, intptr lParam)'),
  }
  return activationApi
}

export function readWindowsSelection() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', SELECTION_SCRIPT], {
      timeout: 1500,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof parsed.text !== 'string') {
          resolve(undefined)
          return
        }
        resolve({
          text: parsed.text,
          ...typeof parsed.pid === 'number' ? { pid: parsed.pid } : {},
          ...typeof parsed.x === 'number' ? { x: parsed.x } : {},
          ...typeof parsed.y === 'number' ? { y: parsed.y } : {},
          ...typeof parsed.width === 'number' ? { width: parsed.width } : {},
          ...typeof parsed.height === 'number' ? { height: parsed.height } : {},
        })
      } catch {
        resolve(undefined)
      }
    })
  })
}

export function activateWindowsPid(pid) {
  const lib = prepareKoffi()
  const api = windowsActivationApi()
  let found = false
  const callback = lib.register((hwnd) => {
    if (found || api.IsWindowVisible(hwnd) === 0) return 1
    const slot = [0]
    api.GetWindowThreadProcessId(hwnd, slot)
    if (slot[0] === pid) {
      api.SetForegroundWindow(hwnd)
      found = true
    }
    return 1
  }, lib.pointer('DshOrbSelEnumProc'))
  try {
    api.EnumWindows(callback, 0)
  } finally {
    lib.unregister(callback)
  }
}

function dip(user32, shcore, x, y) {
  const monitorFromPoint = user32.func('void * __stdcall MonitorFromPoint(DSH_ORB_SEL_POINT pt, uint32 dwFlags)')
  const monitor = monitorFromPoint({ x, y }, MONITOR_DEFAULTTONEAREST)
  const dpiX = [0]
  const dpiY = [0]
  const dpiForMonitor = shcore.func(
    'int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)',
  )
  if (dpiForMonitor(monitor, 0, dpiX, dpiY) !== 0) return { x, y }
  const scale = (dpiX[0] ?? 96) / 96
  if (!Number.isFinite(scale) || scale <= 0) return { x, y }
  return { x: x / scale, y: y / scale }
}

export function installWindowsSelectionHooks(dispatch) {
  const lib = prepareKoffi()
  const user32 = lib.load('user32.dll')
  const shcore = lib.load('shcore.dll')
  const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, intptr lParam)')
  const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, DshOrbSelHookProc *lpfn, void *hMod, uint32 dwThreadId)')
  const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)')
  const hooks = []
  const callbacks = []
  const mouse = lib.register((code, wParam, lParam) => {
    try {
      if (code >= 0) {
        const info = lib.decode(lParam, 'DSH_ORB_SEL_MSLL')
        const pointDip = dip(user32, shcore, info.pt.x, info.pt.y)
        const kind = Number(wParam)
        if (kind === WM_MOUSEWHEEL) dispatch({ type: 'wheel' })
        else if (kind === WM_LBUTTONDOWN) dispatch({ type: 'mouse-down', ...pointDip, button: 'left' })
        else if (kind === WM_LBUTTONUP) dispatch({ type: 'mouse-up', ...pointDip, button: 'left' })
        else if (kind === WM_RBUTTONDOWN || kind === WM_RBUTTONUP) dispatch({ type: 'mouse-down', ...pointDip, button: 'right' })
        else if (kind === WM_MBUTTONDOWN || kind === WM_MBUTTONUP) dispatch({ type: 'mouse-down', ...pointDip, button: 'middle' })
      }
    } catch {
      // A hook fault must not swallow the rest of the mouse chain.
    }
    return CallNextHookEx(null, code, wParam, lParam)
  }, lib.pointer('DshOrbSelHookProc'))
  callbacks.push(mouse)
  hooks.push(SetWindowsHookExW(WH_MOUSE_LL, mouse, null, 0))
  const keyboard = lib.register((code, wParam, lParam) => {
    try {
      if (code >= 0) {
        const kind = Number(wParam)
        if (kind === WM_KEYDOWN || kind === WM_SYSKEYDOWN) dispatch({ type: 'key' })
      }
    } catch {
      // A hook fault must not swallow the rest of the keyboard chain.
    }
    return CallNextHookEx(null, code, wParam, lParam)
  }, lib.pointer('DshOrbSelHookProc'))
  callbacks.push(keyboard)
  hooks.push(SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, null, 0))
  return () => {
    for (const hook of hooks) {
      if (hook !== null && hook !== undefined) UnhookWindowsHookEx(hook)
    }
    for (const callback of callbacks) lib.unregister(callback)
  }
}

export function productionSelectionProbe() {
  return {
    readSelection: readWindowsSelection,
    activatePid: activateWindowsPid,
  }
}
