import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contextMenuTemplate } from '../src/menu.ts'
import { modelMenuItems } from '../src/model-menu.ts'

const here = dirname(fileURLToPath(import.meta.url))

const catalog = {
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'plain', name: 'Plain' },
      {
        id: 'deepseek-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }], defaultEffort: 'max' },
      },
    ],
  }],
}

describe('ball menu', () => {
  it('checks the current model and uses a radio submenu for thinking models', () => {
    const chosen: unknown[] = []
    const items = modelMenuItems(catalog, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    }, (selection) => { chosen.push(selection) }, { empty: '没有可用的模型。', defaultEffort: '默认' })
    assert.equal(items[0]?.label, 'DeepSeek')
    assert.equal(items[0]?.enabled, false)
    const plain = items.find((item) => item.label === 'Plain')
    assert.equal(plain?.type, 'checkbox')
    assert.equal(plain?.checked, false)
    plain?.click?.({ checked: true })
    assert.deepEqual(chosen[0], { provider: 'deepseek-official', model: 'plain' })
    const flash = items.find((item) => item.label === '✓ Flash')
    assert.equal(flash?.submenu?.[0]?.type, 'radio')
    assert.equal(flash?.submenu?.find((item) => item.label === 'High')?.checked, true)
    assert.equal(flash?.submenu?.find((item) => item.label === 'Max')?.checked, false)
    flash?.submenu?.find((item) => item.label === 'Max')?.click?.({ checked: true })
    assert.deepEqual(chosen[1], { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.deepEqual(modelMenuItems({ groups: [] }, { provider: 'x', model: 'y' }, () => {}, {
      empty: '没有可用的模型。',
      defaultEffort: '默认',
    }), [{ label: '没有可用的模型。', enabled: false }])
  })

  it('lists open, both models, the selection switch, coordinates, and disable', () => {
    const actions: string[] = []
    const template = contextMenuTemplate({
      catalog,
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      selectionEnabled: true,
      millifractionEnabled: false,
      openMain: true,
    }, true, {
      openMain: () => { actions.push('open') },
      setOverlay: () => { actions.push('overlay') },
      setBackground: () => { actions.push('background') },
      setSelection: (enabled) => { actions.push(`selection:${enabled}`) },
      setMillifraction: (enabled) => { actions.push(`fraction:${enabled}`) },
      disable: () => { actions.push('disable') },
    })
    assert.deepEqual(template.map((item) => item.label ?? item.type), [
      '打开主窗口',
      '悬浮球 Agent 模型',
      '后台 Agent 模型',
      '划词工具栏',
      '千分比坐标',
      'separator',
      '停用悬浮球',
    ])
    assert.equal(template[0]?.enabled, true)
    template[0]?.click?.({ checked: false })
    template[3]?.click?.({ checked: false })
    template[4]?.click?.({ checked: true })
    template[6]?.click?.({ checked: false })
    const background = template[2]?.submenu?.find((item) => item.label === '✓ Flash')
    assert.equal(background?.submenu?.find((item) => item.label === 'Max')?.checked, true)
    background?.submenu?.[0]?.click?.({ checked: true })
    assert.deepEqual(actions, ['open', 'selection:false', 'fraction:true', 'disable', 'background'])
    const english = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      selectionEnabled: false,
      millifractionEnabled: false,
      openMain: false,
    }, false, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setSelection() {},
      setMillifraction() {},
      disable() {},
    })
    assert.equal(english[0]?.label, 'Open Main Window')
    assert.equal(english[0]?.enabled, false)
    assert.equal(english.at(-1)?.label, 'Disable floating ball')
  })

  it('wires the page to the same control messages the host accepts', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    for (const name of ['requestHistory', 'openSession', 'newSession', 'setPermission', 'stop', 'onHistory', 'onPermission', 'onReset', 'onAvatar']) {
      assert.match(shell, new RegExp(`api\\.${name}\\(`))
      assert.match(preload, new RegExp(`${name}\\(`))
    }
    assert.match(shell, /read-only/)
    assert.match(shell, /workspace-write/)
    assert.match(shell, /danger-full-access/)
    assert.match(main, /context-menu/)
    assert.match(main, /isEditable/)
    assert.match(main, /setTimeout/)
    assert.match(preload, /orb:history/)
    assert.match(preload, /orb:stop/)
    assert.match(preload, /x-dsh-orb-helper|orb:avatar/)
  })
})
