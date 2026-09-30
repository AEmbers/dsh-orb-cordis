import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectChromeWindowIds,
  windowIdFromHandle,
  type NativeHandleWindow,
} from '../src/chrome-windows.ts'

function handleWindow(value: bigint): NativeHandleWindow {
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(value)
  return { getNativeWindowHandle: () => handle }
}

describe('chrome window handles', () => {
  it('reads a pointer-sized handle and a 32-bit handle as the same id the host walks', () => {
    const wide = Buffer.alloc(8)
    wide.writeBigUInt64LE(0x0000_0000_0012_3456n)
    assert.equal(windowIdFromHandle(wide), 0x123456)
    const narrow = Buffer.alloc(4)
    narrow.writeUInt32LE(0x123456)
    assert.equal(windowIdFromHandle(narrow), 0x123456)
  })

  it('refuses an empty buffer, a null handle, and an id past safe integers', () => {
    assert.equal(windowIdFromHandle(Buffer.alloc(0)), undefined)
    assert.equal(windowIdFromHandle(Buffer.alloc(2)), undefined)
    assert.equal(windowIdFromHandle(Buffer.alloc(8)), undefined)
    const huge = Buffer.alloc(8)
    huge.writeBigUInt64LE(0xFFFF_FFFF_FFFF_FFFFn)
    assert.equal(windowIdFromHandle(huge), undefined)
  })

  it('collects unique ids on Windows and nothing on the other platforms', () => {
    const ball = handleWindow(11n)
    const toolbar = handleWindow(22n)
    const frame = handleWindow(11n)
    assert.deepEqual(collectChromeWindowIds([ball, toolbar, frame], 'win32'), [11, 22])
    assert.deepEqual(collectChromeWindowIds([ball, toolbar], 'darwin'), [])
    assert.deepEqual(collectChromeWindowIds([ball, toolbar], 'linux'), [])
    assert.deepEqual(collectChromeWindowIds([undefined, toolbar], 'win32'), [22])
  })

  it('drops a window whose handle cannot be read', () => {
    const gone: NativeHandleWindow = {
      getNativeWindowHandle() {
        throw new Error('window is gone')
      },
    }
    assert.deepEqual(collectChromeWindowIds([gone, handleWindow(7n)], 'win32'), [7])
  })
})
