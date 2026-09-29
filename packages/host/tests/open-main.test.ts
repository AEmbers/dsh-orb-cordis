import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mainWindowTarget, openCommand } from '../src/open-main.ts'
import { isDesktopHost, isTccRight, tccAppName } from '../src/tcc.ts'

describe('open main window', () => {
  it('uses dsh://open for the desktop host and a loopback page for dsh web', () => {
    const secret = 'token=do-not-log'
    const ctx = {
      webServer: { port: 19387 },
      connection: {
        authenticatedUrl: (base: string) => `${base}/?${secret}`,
      },
    }
    assert.equal(mainWindowTarget(ctx, true), 'dsh://open')
    const web = mainWindowTarget(ctx, false)
    assert.equal(web, 'http://127.0.0.1:19387/?token=do-not-log')
    assert.match(web ?? '', /^http:\/\/127\.0\.0\.1:19387\//)
    assert.equal(mainWindowTarget({
      webServer: { port: 1 },
      connection: { authenticatedUrl: () => 'http://example.com/?token=do-not-log' },
    }, false), undefined)
    assert.equal(mainWindowTarget({
      webServer: { port: 1 },
      connection: { authenticatedUrl: () => { throw new Error('token=do-not-log') } },
    }, false), undefined)
    assert.deepEqual(openCommand('dsh://open', 'darwin'), { command: 'open', args: ['dsh://open'] })
    assert.deepEqual(openCommand('http://127.0.0.1:1/', 'win32'), {
      command: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:1/'],
    })
  })

  it('names the permission dialog DeepSeek Harness on the desktop host and the terminal otherwise', () => {
    const previous = process.env.DSH_DESKTOP_NODE_EXECUTABLE
    process.env.DSH_DESKTOP_NODE_EXECUTABLE = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
    try {
      assert.equal(isDesktopHost(), true)
      assert.equal(tccAppName(), 'DeepSeek Harness')
    } finally {
      if (previous === undefined) delete process.env.DSH_DESKTOP_NODE_EXECUTABLE
      else process.env.DSH_DESKTOP_NODE_EXECUTABLE = previous
    }
    if (!process.execPath.includes('DeepSeek Harness')) {
      const lang = process.env.LANG
      process.env.LANG = 'zh_CN.UTF-8'
      try {
        assert.equal(tccAppName(), '终端')
      } finally {
        if (lang === undefined) delete process.env.LANG
        else process.env.LANG = lang
      }
    }
    assert.equal(isTccRight('screen'), true)
    assert.equal(isTccRight('accessibility'), true)
    assert.equal(isTccRight('camera'), false)
  })
})
