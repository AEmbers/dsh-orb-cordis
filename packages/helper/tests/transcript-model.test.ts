import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { processLabel, reasoningSummary } from '../assets/transcript-model.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('reasoning summary', () => {
  it('keeps the latest completed paragraph while streaming', () => {
    assert.equal(reasoningSummary('还在想', true), '')
    assert.equal(reasoningSummary('第一段标题\n还在写', true), '第一段标题')
    assert.equal(reasoningSummary('第一行\n第一段剩余\n\n第二行\n还在写', true), '第二行')
    assert.equal(reasoningSummary('第一行\n\n还没写完', true), '第一行')
  })

  it('uses the first line once the block has settled', () => {
    assert.equal(reasoningSummary('全文第一行\n第二行', false), '全文第一行')
    assert.equal(reasoningSummary('\n后面才有字', false), '')
  })

  it('strips bold markers from the collapsed summary', () => {
    assert.equal(reasoningSummary('**加粗**\n未完成', true), '加粗')
    assert.equal(reasoningSummary('**你好**世界\n下一行', false), '你好世界')
    assert.equal(reasoningSummary('  **标题**\n第二行', false), '  标题')
  })
})

describe('turn process label', () => {
  it('formats live seconds and minutes without padded seconds', () => {
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 200 }), '深度求索中，用时1秒')
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 5000 }), '深度求索中，用时5秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 5000 }), 'Deep diving for 5s')
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 65000 }), '深度求索中，用时1分5秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 65000 }), 'Deep diving for 1m 5s')
  })

  it('pads settled minutes and keeps a space before the duration', () => {
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 65000 }), '用时 1分05秒')
    assert.equal(processLabel({ zh: false, running: false, elapsedMs: 65000 }), 'Took 1m 05s')
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 3_661_000 }), '用时 1小时01分01秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 3_661_000 }), 'Deep diving for 1h 01m 1s')
  })

  it('uses the replay label when the turn has no start time', () => {
    assert.equal(processLabel({ zh: true, running: false }), '已思考')
    assert.equal(processLabel({ zh: false, running: false }), 'Thought for a while')
    assert.equal(processLabel({ zh: true, running: true }), '深度求索中')
  })
})

describe('ball page module', () => {
  it('imports the transcript model from the helper page', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const html = readFileSync(join(here, '../assets/floating.html'), 'utf8')
    assert.match(shell, /from '\.\/transcript-model\.js'/)
    assert.match(shell, /reasoningSummary\(/)
    assert.match(shell, /processLabel\(/)
    assert.match(html, /type="module" src="shell\.js"/)
  })
})
