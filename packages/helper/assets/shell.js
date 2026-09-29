import { processLabel, reasoningSummary } from './transcript-model.js'

const api = window.dshOrb
const COLLAPSE_MS = 180
const ANIMATION_MS = 300
const DOCK_HOVER_DELAY_MS = 800
const DOCK_DRAG_OFF_PX = 24
const COMPOSER_MIN_PX = 72
const COMPOSER_LINE_PX = 20
const COMPOSER_MAX_PX = COMPOSER_MIN_PX + COMPOSER_LINE_PX * 3
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']

const zh = {
  title: '桌面 agent',
  stop: '停止',
  fresh: '新建',
  history: '历史',
  historyEmpty: '还没有 Computer Use 对话。',
  untitled: '未命名对话',
  placeholder: '向桌面 agent 发送消息…',
  accessReadOnly: '仅可查看',
  accessWrite: '工作区内修改',
  accessFull: '完全权限',
  cancel: '放弃',
  skip: '跳过',
  next: '下一题',
  submit: '提交',
  prev: '上一题',
  recommended: '推荐',
  custom: '输入你的答案',
  incomplete: '请先完成这道问题。',
  unanswered: '请选择一个选项或填写自定义答案。',
  think: '思考',
  running: '运行中',
  tooLong: '最多 8000 个字符，已保留输入。',
  truncated: '已截断',
}
const en = {
  title: 'Desktop agent',
  stop: 'Stop',
  fresh: 'New',
  history: 'History',
  historyEmpty: 'No Computer Use chats yet.',
  untitled: 'Untitled',
  placeholder: 'Ask the desktop agent…',
  accessReadOnly: 'Read Only',
  accessWrite: 'Workspace Write',
  accessFull: 'Full access',
  cancel: 'Dismiss',
  skip: 'Skip',
  next: 'Next',
  submit: 'Submit',
  prev: 'Previous question',
  recommended: 'Recommended',
  custom: 'Type your answer',
  incomplete: 'Please complete this question first.',
  unanswered: 'Please select an option or enter a custom answer.',
  think: 'Think',
  running: 'Running',
  tooLong: 'Limit is 8000 characters. The text was kept.',
  truncated: 'truncated',
}

const PROMPT_LIMIT = 8000
const messages = navigator.language.toLowerCase().startsWith('zh') ? zh : en

function applyColorScheme(dark) {
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.documentElement.toggleAttribute('data-ds-dark-theme', dark)
}

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
applyColorScheme(colorScheme.matches)
colorScheme.addEventListener('change', () => applyColorScheme(colorScheme.matches))

function promptText(prompt) {
  return (prompt.innerText ?? prompt.textContent ?? '').replaceAll('\u00a0', ' ')
}

function clipSelection(text) {
  if (text.length <= PROMPT_LIMIT) return text
  const mark = `\n${messages.truncated}`
  return `${text.slice(0, Math.max(0, PROMPT_LIMIT - mark.length))}${mark}`
}

function insertPlainText(prompt, text) {
  if (text === '') return
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return
  prompt.append(text)
}

function editableTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement
  if (element == null || typeof element.closest !== 'function') return false
  return element.closest('input, textarea, [contenteditable="true"]') !== null
}

function isComposing(event) {
  return event.isComposing === true || event.keyCode === 229
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}

function renderMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
}

const THINK_MARKUP = '<path d="M10.7554 5.24466C13.9891 8.4783 15.3769 12.3333 13.8552 13.8551C12.3335 15.3768 8.4785 13.989 5.24478 10.7553C2.01111 7.52165 0.623307 3.66664 2.14504 2.14491C3.66676 0.623189 7.52178 2.01099 10.7554 5.24466Z" stroke="currentColor"></path><path d="M10.7554 10.7553C7.52178 13.989 3.66676 15.3768 2.14504 13.8551C0.623307 12.3333 2.01111 8.4783 5.24478 5.24466C8.4785 2.01099 12.3335 0.623189 13.8552 2.14491C15.3769 3.66664 13.9891 7.52165 10.7554 10.7553Z" stroke="currentColor"></path><path d="M8.9587 8.00025C8.9587 8.52835 8.5306 8.95655 8.0024 8.95655C7.47429 8.95655 7.04614 8.52835 7.04614 8.00025C7.04614 7.47209 7.47429 7.04395 8.0024 7.04395C8.5306 7.04395 8.9587 7.47209 8.9587 8.00025Z" fill="currentColor"></path>'
const CHEVRON_DOWN = '<path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor"></path>'
const CHEVRON_UP = '<path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" stroke="currentColor"></path>'

function icon(markup) {
  const host = document.createElement('span')
  host.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`
  return host.firstElementChild
}

function parseRecommendedLabel(label) {
  return RECOMMENDED_SUFFIX.test(label)
    ? { label: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { label, recommended: false }
}

function emptyDrafts(questions) {
  return questions.map(() => ({ selected: [], custom: '', skipped: false }))
}

function draftAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

function draftCompleted(draft) {
  return draftAnswered(draft) || draft.skipped
}

function buildAnswer(questions, drafts) {
  return {
    answers: questions.map((item, index) => {
      const value = drafts[index]
      if (value.skipped) return { id: item.id, selected: [] }
      const custom = value.custom.trim()
      return {
        id: item.id,
        selected: custom === '' || item.multiSelect === true ? value.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

function permissionText(preset) {
  if (preset === 'read-only') return messages.accessReadOnly
  if (preset === 'workspace-write') return messages.accessWrite
  return messages.accessFull
}

function main() {
  document.documentElement.lang = messages === zh ? 'zh' : 'en'
  document.querySelector('#page-title').textContent = messages.title
  const stop = document.querySelector('#stop')
  stop.setAttribute('aria-label', messages.stop)
  stop.title = messages.stop
  const newConversation = document.querySelector('#new-conversation')
  newConversation.setAttribute('aria-label', messages.fresh)
  newConversation.title = messages.fresh
  const historyButton = document.querySelector('#history')
  historyButton.setAttribute('aria-label', messages.history)
  historyButton.title = messages.history
  const permissionRoot = document.querySelector('#permission')
  const permissionButton = document.querySelector('#permission-button')
  const permissionLabel = document.querySelector('#permission-label')
  const permissionMenu = document.querySelector('#permission-menu')
  document.querySelector('#input-label').textContent = messages.placeholder
  const ball = document.querySelector('#ball')
  const dockTab = document.querySelector('#dock-tab')
  const panel = document.querySelector('#panel')
  const transcript = document.querySelector('#transcript')
  const questionRoot = document.querySelector('#question')
  const questionEyebrow = document.querySelector('#question-eyebrow')
  const questionTitle = document.querySelector('#question-title')
  const questionDetail = document.querySelector('#question-detail')
  const questionOptions = document.querySelector('#question-options')
  const questionCustom = document.querySelector('#question-custom')
  const questionError = document.querySelector('#question-error')
  const questionPager = document.querySelector('#question-pager')
  const questionProgress = document.querySelector('#question-progress')
  const questionPrev = document.querySelector('#question-prev')
  const questionNextNav = document.querySelector('#question-next-nav')
  const questionSkip = document.querySelector('#question-skip')
  const questionContinue = document.querySelector('#question-continue')
  const questionCancel = document.querySelector('#question-cancel')
  const historyList = document.querySelector('#history-list')
  const status = document.querySelector('#status')
  const prompt = document.querySelector('#prompt')
  const composer = document.querySelector('#composer')
  prompt.dataset.placeholder = messages.placeholder
  questionCancel.textContent = messages.cancel
  questionSkip.textContent = messages.skip
  questionPrev.setAttribute('aria-label', messages.prev)
  questionNextNav.setAttribute('aria-label', messages.next)
  questionPrev.textContent = '‹'
  questionNextNav.textContent = '›'

  let expanded = false
  let pinned = false
  let running = false
  let processGroup
  let processClock
  let dragging = false
  let collapsing = false
  let skipClick = false
  let skipDockCommit = false
  let suppressExpand = false
  let docked
  let dockHoverArmed = true
  let dockPointerInside = false
  let dockHoverTimer
  let collapseTimer
  let collapseFrame
  let pointer
  let lastOrigin
  let permission = 'danger-full-access'
  let permissionOpen = false
  let historyOpen = false
  let pending
  let sessionId = ''
  let avatarSrc = 'deepseek-avatar-square.gif'
  let historyItems = []
  const blocks = new Map()

  function pageClosed() {
    return globalThis.document?.body == null
  }

  function freezeGif(gif) {
    const still = () => {
      if (gif.dataset.mode !== 'still' || gif.naturalWidth === 0) return
      const canvas = document.createElement('canvas')
      canvas.width = gif.naturalWidth
      canvas.height = gif.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) return
      context.drawImage(gif, 0, 0)
      try {
        gif.src = canvas.toDataURL()
      } catch {
        // The GIF already reset to its first frame.
      }
    }
    if (gif.complete && gif.naturalWidth > 0) still()
    else gif.addEventListener('load', still, { once: true })
  }

  function asking() {
    return pending !== undefined
  }

  function syncGif() {
    if (pageClosed()) return
    const gif = document.querySelector('#ball-gif')
    const play = expanded || running || asking()
    if (play) {
      if (gif.dataset.mode !== 'play') {
        gif.dataset.mode = 'play'
        gif.src = avatarSrc
      }
      return
    }
    if (gif.dataset.mode === 'still') return
    gif.dataset.mode = 'still'
    gif.src = avatarSrc
    freezeGif(gif)
  }

  function setRunning(next) {
    running = next
    if (pageClosed()) return
    document.body.classList.toggle('running', running)
    stop.hidden = !expanded || !running
    syncGif()
    if (next) {
      const group = ensureProcess()
      if (!group.live) {
        group.live = true
        group.startedAt = Date.now()
        group.elapsedMs = undefined
        setProcessOpen(group, true)
        refreshProcessLabel(group)
        startProcessClock()
      }
    } else if (processGroup) {
      stopProcessClock()
      freezeProcess(processGroup)
      setProcessOpen(processGroup, false)
      refreshProcessLabel(processGroup)
    }
  }

  function applyDirection(state) {
    document.body.classList.toggle('expand-left', state.horizontal === 'left')
    document.body.classList.toggle('expand-right', state.horizontal === 'right')
    document.body.classList.toggle('expand-up', state.vertical === 'up')
    document.body.classList.toggle('expand-down', state.vertical === 'down')
  }

  function clearDockHoverTimer() {
    if (dockHoverTimer === undefined) return
    clearTimeout(dockHoverTimer)
    dockHoverTimer = undefined
  }

  function applyDocked(side) {
    const next = side === 'left' || side === 'right' ? side : undefined
    const becameDocked = docked === undefined && next !== undefined
    docked = next
    document.body.classList.toggle('docked', next !== undefined)
    document.body.classList.toggle('docked-left', next === 'left')
    document.body.classList.toggle('docked-right', next === 'right')
    clearDockHoverTimer()
    if (next === undefined) {
      dockTab.hidden = true
      dockHoverArmed = true
      return
    }
    if (becameDocked) {
      dockHoverArmed = false
      dockHoverTimer = setTimeout(() => {
        dockHoverTimer = undefined
        dockHoverArmed = true
        if (dockPointerInside) void unsnapDocked()
      }, DOCK_HOVER_DELAY_MS)
    }
    dockTab.hidden = false
  }

  function applyDockedFrom(result) {
    if (result == null) return
    applyDocked(result.docked)
  }

  async function moveBall(x, y) {
    applyDockedFrom(await api.move(x, y, !(running || asking())))
  }

  async function clampBall() {
    applyDockedFrom(await api.clamp(!(running || asking())))
  }

  async function unsnapDocked() {
    if (docked === undefined) return
    suppressExpand = true
    if (dragging) skipDockCommit = true
    applyDocked(undefined)
    applyDockedFrom(await api.unsnap())
  }

  async function setExpanded(next, force = false) {
    if (pageClosed()) return
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer)
      collapseTimer = undefined
    }
    if (collapseFrame !== undefined) {
      clearTimeout(collapseFrame)
      collapseFrame = undefined
    }
    if (next) {
      const state = await api.setExpanded(true)
      applyDocked(undefined)
      applyDirection(state)
      panel.hidden = false
      expanded = true
      document.body.classList.add('expanded')
      stop.hidden = !running
      syncGif()
      return
    }
    if (!force && (pinned || running || asking())) return
    expanded = false
    document.body.classList.remove('expanded')
    if (docked !== undefined) dockTab.hidden = false
    stop.hidden = true
    syncGif()
    if (force) {
      panel.hidden = true
      await api.setExpanded(false)
      return
    }
    collapseFrame = setTimeout(() => {
      collapseFrame = undefined
      panel.hidden = true
      void api.setExpanded(false)
    }, ANIMATION_MS)
  }

  function ballGrabOffset(event) {
    const rect = ball.getBoundingClientRect()
    return { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }

  function scheduleCollapse() {
    if (pinned || running || asking() || dragging) return
    if (collapseTimer !== undefined) clearTimeout(collapseTimer)
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      void setExpanded(false)
    }, COLLAPSE_MS)
  }

  function draftOverflows() {
    return prompt.scrollHeight > prompt.clientHeight + 1
  }

  function syncComposerHeight() {
    const empty = promptText(prompt).trim() === ''
    prompt.classList.toggle('prompt-empty', empty)
    if (empty) {
      document.body.classList.remove('composer-capped')
      document.body.style.setProperty('--composer-height', 'var(--ball)')
      return
    }
    document.body.classList.remove('composer-capped')
    let height = COMPOSER_MIN_PX
    for (;;) {
      document.body.style.setProperty('--composer-height', `${height}px`)
      if (!draftOverflows() || height >= COMPOSER_MAX_PX) break
      height = Math.min(COMPOSER_MAX_PX, height + COMPOSER_LINE_PX)
    }
    document.body.classList.toggle('composer-capped', draftOverflows())
  }

  function clearPrompt() {
    prompt.textContent = ''
    prompt.classList.add('prompt-empty')
    document.body.classList.remove('composer-capped')
    document.body.style.setProperty('--composer-height', 'var(--ball)')
  }

  function refreshProcessLabel(group) {
    if (!group) return
    const elapsedMs = group.live
      ? group.startedAt === undefined ? undefined : Date.now() - group.startedAt
      : group.elapsedMs
    group.label.textContent = processLabel({
      zh: messages === zh,
      running: group.live,
      elapsedMs,
    })
  }

  function setProcessOpen(group, open) {
    if (!group) return
    group.preferredOpen = open
    const foldable = group.body.childElementCount > 0
    const shown = open && foldable
    group.section.toggleAttribute('data-open', shown)
    group.header.toggleAttribute('data-open', shown)
    group.header.disabled = !foldable
    group.chevron.hidden = !foldable
    if (foldable) group.header.setAttribute('aria-expanded', String(shown))
    else group.header.removeAttribute('aria-expanded')
  }

  function freezeProcess(group) {
    if (!group?.live) return
    group.elapsedMs = group.startedAt === undefined ? undefined : Date.now() - group.startedAt
    group.live = false
  }

  function stopProcessClock() {
    if (processClock === undefined) return
    clearInterval(processClock)
    processClock = undefined
  }

  function startProcessClock() {
    stopProcessClock()
    processClock = setInterval(() => {
      if (processGroup?.live) refreshProcessLabel(processGroup)
    }, 1000)
  }

  function closeProcess() {
    const group = processGroup
    if (!group) return
    stopProcessClock()
    freezeProcess(group)
    refreshProcessLabel(group)
    setProcessOpen(group, false)
    processGroup = undefined
  }

  function ensureProcess() {
    if (processGroup) return processGroup
    const section = document.createElement('section')
    section.className = 'turn'
    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'process'
    const label = document.createElement('span')
    label.className = 'process-label'
    const chevron = icon(CHEVRON_DOWN)
    chevron.classList.add('process-chevron')
    header.append(label, chevron)
    const body = document.createElement('div')
    body.className = 'process-body'
    const answer = document.createElement('div')
    answer.className = 'turn-answer'
    section.append(header, body, answer)
    const loose = []
    let anchor = null
    for (const child of transcript.children) {
      if (child.dataset?.kind === 'user') {
        loose.length = 0
        anchor = null
        continue
      }
      if (child.dataset?.kind === 'assistant') {
        if (anchor === null) anchor = child
        loose.push(child)
      }
    }
    if (anchor) transcript.insertBefore(section, anchor)
    else transcript.append(section)
    for (const node of loose) answer.append(node)
    const live = running
    const group = {
      section, header, label, chevron, body, answer, live,
      startedAt: live ? Date.now() : undefined,
      elapsedMs: undefined,
      preferredOpen: live,
    }
    processGroup = group
    header.addEventListener('click', () => {
      if (header.disabled) return
      setProcessOpen(group, !section.hasAttribute('data-open'))
    })
    setProcessOpen(group, live)
    refreshProcessLabel(group)
    if (live) startProcessClock()
    return group
  }

  function syncThinkPreview(node) {
    const summary = node.querySelector('.think-summary-text')?.textContent ?? ''
    node.toggleAttribute('data-preview', !node.hasAttribute('data-expanded') && summary !== '')
  }

  function createThink(node) {
    node.dataset.variant = 'think'
    const status = document.createElement('span')
    status.className = 'visually-hidden'
    const disclosure = document.createElement('div')
    disclosure.className = 'think-disclosure'
    const row = document.createElement('div')
    row.className = 'think-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'think-leading'
    const idle = document.createElement('span')
    idle.className = 'think-icon-idle'
    idle.append(icon(THINK_MARKUP))
    const hover = document.createElement('span')
    hover.className = 'think-chevron-hover'
    hover.append(icon(CHEVRON_DOWN))
    const openChevron = document.createElement('span')
    openChevron.className = 'think-chevron-open'
    openChevron.append(icon(CHEVRON_UP))
    leading.append(idle, hover, openChevron)
    const title = document.createElement('span')
    title.className = 'think-title'
    title.textContent = messages.think
    const separator = document.createElement('span')
    separator.className = 'think-separator'
    separator.setAttribute('aria-hidden', 'true')
    const summary = document.createElement('span')
    summary.className = 'think-summary'
    const summaryText = document.createElement('span')
    summaryText.className = 'think-summary-text'
    summary.append(summaryText)
    row.append(leading, title, separator, summary)
    const body = document.createElement('div')
    body.className = 'think-body block-body'
    disclosure.append(row, body)
    node.append(status, disclosure)
    const toggle = () => {
      const open = !node.hasAttribute('data-expanded')
      node.toggleAttribute('data-expanded', open)
      disclosure.toggleAttribute('data-open', open)
      row.setAttribute('aria-expanded', String(open))
      syncThinkPreview(node)
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
  }

  function placeBlock(node, kind) {
    if (kind === 'user') {
      closeProcess()
      transcript.append(node)
      return
    }
    if (kind === 'assistant') {
      if (processGroup) processGroup.answer.append(node)
      else transcript.append(node)
      return
    }
    const group = ensureProcess()
    group.body.append(node)
    setProcessOpen(group, group.preferredOpen === true)
  }

  function upsertBlock(block) {
    if (typeof block?.key !== 'string' || typeof block.text !== 'string') return
    let node = blocks.get(block.key)
    if (node === undefined) {
      node = document.createElement('article')
      node.className = 'block'
      node.dataset.kind = block.kind
      if (block.kind === 'reasoning') createThink(node)
      else {
        const body = document.createElement('div')
        body.className = 'block-body'
        node.append(body)
      }
      blocks.set(block.key, node)
      placeBlock(node, block.kind)
    }
    node.dataset.state = block.running ? 'running' : 'ok'
    if (block.kind === 'reasoning') {
      const summary = reasoningSummary(block.text, block.running === true)
      node.querySelector('.think-summary-text').textContent = summary
      const preview = node.querySelector('.think-summary')
      if (block.running) preview.setAttribute('data-streaming', 'true')
      else preview.removeAttribute('data-streaming')
      node.querySelector('.visually-hidden').textContent = block.running ? messages.running : ''
      node.querySelector('.think-body').innerHTML = renderMarkdown(block.text)
      syncThinkPreview(node)
    } else if (block.kind === 'tool') {
      node.querySelector('.block-body').textContent = block.text
    } else {
      node.querySelector('.block-body').innerHTML = renderMarkdown(block.text)
    }
    transcript.scrollTop = transcript.scrollHeight
  }

  function renderHistory() {
    historyList.replaceChildren()
    if (historyItems.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = messages.historyEmpty
      historyList.append(empty)
      return
    }
    for (const item of historyItems) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = item.sessionId === sessionId ? 'history-row current' : 'history-row'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(item.sessionId === sessionId))
      button.textContent = typeof item.title === 'string' && item.title !== '' ? item.title : messages.untitled
      button.addEventListener('click', () => {
        setHistoryOpen(false)
        if (item.sessionId !== sessionId) api.openSession(item.sessionId)
      })
      historyList.append(button)
    }
  }

  function clearTranscript() {
    stopProcessClock()
    processGroup = undefined
    blocks.clear()
    transcript.replaceChildren()
    pending = undefined
    syncQuestion()
  }

  function setHistoryOpen(next) {
    historyOpen = next
    historyList.hidden = !historyOpen
    historyButton.setAttribute('aria-pressed', String(historyOpen))
    if (historyOpen) {
      renderHistory()
      api.requestHistory()
      setPermissionOpen(false)
    }
    syncQuestion()
  }

  function setPermissionOpen(next) {
    permissionOpen = next
    permissionMenu.hidden = !permissionOpen
    permissionButton.setAttribute('aria-expanded', String(permissionOpen))
  }

  function renderPermission() {
    permissionLabel.textContent = permissionText(permission)
    for (const option of permissionMenu.querySelectorAll('button')) {
      option.setAttribute('aria-selected', String(option.dataset.preset === permission))
    }
  }

  function syncContinue() {
    const draft = pending.drafts[pending.index]
    questionContinue.textContent = pending.index === pending.questions.length - 1
      ? messages.submit
      : messages.next
    questionContinue.disabled = pending.busy || !draftAnswered(draft)
    questionSkip.disabled = pending.busy
    questionCancel.disabled = pending.busy
    questionPrev.disabled = pending.busy || pending.index === 0
    questionNextNav.disabled = pending.busy || pending.index === pending.questions.length - 1
    questionCustom.disabled = pending.busy
    questionCustom.hidden = false
    questionCustom.placeholder = messages.custom
    if (document.activeElement !== questionCustom) questionCustom.value = draft.custom
  }

  function renderQuestion() {
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    const hasHeader = typeof item.header === 'string' && item.header !== ''
    questionEyebrow.hidden = !hasHeader
    questionEyebrow.textContent = hasHeader ? item.header : ''
    questionTitle.textContent = item.question
    const hasDetail = typeof item.detail === 'string' && item.detail !== ''
    questionDetail.hidden = !hasDetail
    questionDetail.textContent = hasDetail ? item.detail : ''
    questionOptions.replaceChildren()
    const options = item.options ?? []
    questionOptions.setAttribute('role', item.multiSelect === true ? 'group' : 'radiogroup')
    for (const [optionIndex, option] of options.entries()) {
      const selected = draft.selected.includes(option.label)
      const display = parseRecommendedLabel(option.label)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = selected ? 'question-option selected' : 'question-option'
      button.setAttribute('role', item.multiSelect === true ? 'checkbox' : 'radio')
      button.setAttribute('aria-checked', String(selected))
      button.disabled = pending.busy
      const mark = document.createElement('span')
      mark.className = 'question-option-mark'
      mark.textContent = item.multiSelect === true ? (selected ? '\u2713' : '') : String(optionIndex + 1)
      const copy = document.createElement('span')
      copy.className = 'question-option-copy'
      const label = document.createElement('span')
      label.className = 'question-option-label'
      label.textContent = display.label
      copy.append(label)
      if (display.recommended) {
        const badge = document.createElement('span')
        badge.className = 'question-recommended'
        badge.textContent = messages.recommended
        copy.append(badge)
      }
      if (typeof option.description === 'string' && option.description !== '') {
        const description = document.createElement('span')
        description.className = 'question-option-description'
        description.textContent = option.description
        copy.append(description)
      }
      button.append(mark, copy)
      button.addEventListener('click', () => { chooseOption(option.label) })
      questionOptions.append(button)
    }
    questionPager.hidden = pending.questions.length <= 1
    questionProgress.textContent = `${String(pending.index + 1)} / ${String(pending.questions.length)}`
    const hasError = typeof pending.error === 'string' && pending.error !== ''
    questionError.hidden = !hasError
    questionError.textContent = hasError ? pending.error : ''
    syncContinue()
  }

  function syncQuestion() {
    const showCard = pending !== undefined && !historyOpen
    document.body.classList.toggle('asking', pending !== undefined)
    questionRoot.hidden = !showCard
    transcript.hidden = historyOpen
    if (showCard) renderQuestion()
    syncGif()
  }

  function chooseOption(label) {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    if (item.multiSelect === true) {
      draft.selected = draft.selected.includes(label)
        ? draft.selected.filter((entry) => entry !== label)
        : [...draft.selected, label]
    } else {
      draft.selected = [label]
      draft.custom = ''
      if (pending.index < pending.questions.length - 1) pending.index += 1
    }
    draft.skipped = false
    pending.error = undefined
    renderQuestion()
  }

  function submitPending() {
    const missing = pending.drafts.findIndex((draft) => !draftCompleted(draft))
    if (missing >= 0) {
      pending.index = missing
      pending.error = messages.incomplete
      renderQuestion()
      return
    }
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.answerQuestion(pending.id, buildAnswer(pending.questions, pending.drafts).answers)
  }

  function continueFlow() {
    if (pending === undefined || pending.busy) return
    const draft = pending.drafts[pending.index]
    if (!draftAnswered(draft)) {
      pending.error = messages.unanswered
      renderQuestion()
      return
    }
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      pending.error = undefined
      renderQuestion()
      return
    }
    submitPending()
  }

  function skipQuestion() {
    if (pending === undefined || pending.busy) return
    pending.drafts[pending.index] = { selected: [], custom: '', skipped: true }
    pending.error = undefined
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      renderQuestion()
      return
    }
    submitPending()
  }

  function cancelQuestion() {
    if (pending === undefined || pending.busy) return
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.cancelQuestion(pending.id)
  }

  function showQuestion(payload) {
    if (!payload || typeof payload.id !== 'string' || !Array.isArray(payload.questions) || payload.questions.length === 0) return
    if (pending?.id === payload.id) {
      syncQuestion()
      return
    }
    pending = { id: payload.id, questions: payload.questions, drafts: emptyDrafts(payload.questions), index: 0, busy: false }
    setHistoryOpen(false)
    syncQuestion()
    void setExpanded(true)
  }

  function clearQuestion(id) {
    if (pending === undefined || pending.id !== id) return
    pending = undefined
    syncQuestion()
  }

  function isPrimaryButton(event) {
    return event.button === 0
  }

  function primaryButtonHeld(event) {
    return (event.buttons & 1) === 1
  }

  document.body.addEventListener('pointerenter', () => {
    dockPointerInside = true
    if (dragging || collapsing) return
    if (docked !== undefined) {
      if (dockHoverArmed) void unsnapDocked()
      return
    }
    if (suppressExpand) return
    void setExpanded(true)
  })
  document.body.addEventListener('pointerleave', () => {
    dockPointerInside = false
    suppressExpand = false
    if (dragging || collapsing) return
    scheduleCollapse()
  })

  ball.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = false
    lastOrigin = undefined
    pointer = { ...ballGrabOffset(event), startX: event.screenX, startY: event.screenY }
    ball.setPointerCapture(event.pointerId)
  })
  ball.addEventListener('pointermove', (event) => {
    if (pointer === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
    if (!dragging) {
      if (Math.hypot(event.screenX - pointer.startX, event.screenY - pointer.startY) <= 4) return
      dragging = true
      if (running || asking()) {
        void moveBall(lastOrigin.x, lastOrigin.y)
        return
      }
      collapsing = true
      pinned = false
      document.body.classList.remove('pinned')
      void setExpanded(false, true).then(() => {
        collapsing = false
        if (dragging && lastOrigin !== undefined) void moveBall(lastOrigin.x, lastOrigin.y)
      })
      return
    }
    if (!collapsing) void moveBall(lastOrigin.x, lastOrigin.y)
  })
  async function finishPointer(event) {
    if (dragging) {
      skipClick = true
      dragging = false
      collapsing = false
      const origin = pointer === undefined
        ? lastOrigin
        : { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
      pointer = undefined
      lastOrigin = undefined
      const skipDock = skipDockCommit
      skipDockCommit = false
      if (!skipDock) {
        if (origin !== undefined) await moveBall(origin.x, origin.y)
        await clampBall()
      }
      return true
    }
    pointer = undefined
    lastOrigin = undefined
    return false
  }
  ball.addEventListener('pointerup', async (event) => {
    if (!isPrimaryButton(event)) {
      void finishPointer(event)
      return
    }
    const dragged = await finishPointer(event)
    if (dragged || skipClick) {
      skipClick = false
      return
    }
    pinned = !pinned
    document.body.classList.toggle('pinned', pinned)
    if (pinned) await setExpanded(true)
  })
  ball.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  ball.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  dockTab.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = true
    lastOrigin = undefined
    pointer = { dx: 0, dy: 0, startX: event.screenX, startY: event.screenY }
    dockTab.setPointerCapture(event.pointerId)
  })
  dockTab.addEventListener('pointermove', (event) => {
    if (pointer === undefined || docked === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX, y: event.screenY }
    const inward = docked === 'right' ? pointer.startX - event.screenX : event.screenX - pointer.startX
    if (inward <= DOCK_DRAG_OFF_PX) return
    dragging = true
    void unsnapDocked()
  })
  dockTab.addEventListener('pointerup', (event) => { void finishPointer(event) })
  dockTab.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  dockTab.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = promptText(prompt).trim()
    if (text === '') return
    if (text.length > PROMPT_LIMIT) {
      status.textContent = messages.tooLong
      return
    }
    clearPrompt()
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.send(text)
  })
  prompt.addEventListener('input', syncComposerHeight)
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    if (typeof composer.requestSubmit === 'function') composer.requestSubmit()
    else composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  prompt.addEventListener('paste', (event) => {
    event.preventDefault()
    insertPlainText(prompt, event.clipboardData?.getData('text/plain') ?? '')
    syncComposerHeight()
  })
  composer.addEventListener('click', (event) => {
    if (event.target === composer) prompt.focus()
  })

  for (const preset of PERMISSION_PRESETS) {
    const item = document.createElement('li')
    const option = document.createElement('button')
    option.type = 'button'
    option.dataset.preset = preset
    option.setAttribute('role', 'option')
    option.textContent = permissionText(preset)
    option.addEventListener('click', () => {
      permission = preset
      setPermissionOpen(false)
      renderPermission()
      api.setPermission(preset)
    })
    item.append(option)
    permissionMenu.append(item)
  }
  renderPermission()
  permissionButton.addEventListener('click', (event) => {
    event.stopPropagation()
    setHistoryOpen(false)
    setPermissionOpen(!permissionOpen)
  })
  document.addEventListener('pointerdown', (event) => {
    if (permissionRoot.contains(event.target)) return
    setPermissionOpen(false)
  })
  historyButton.addEventListener('click', () => { setHistoryOpen(!historyOpen) })
  newConversation.addEventListener('click', () => {
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.newSession()
    prompt.focus()
  })
  stop.addEventListener('click', () => { api.stop() })
  questionCancel.addEventListener('click', cancelQuestion)
  questionSkip.addEventListener('click', skipQuestion)
  questionContinue.addEventListener('click', continueFlow)
  questionPrev.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === 0) return
    pending.index -= 1
    pending.error = undefined
    renderQuestion()
  })
  questionNextNav.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === pending.questions.length - 1) return
    pending.index += 1
    pending.error = undefined
    renderQuestion()
  })
  questionCustom.addEventListener('input', () => {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    draft.custom = questionCustom.value
    draft.skipped = false
    if (item.multiSelect !== true) draft.selected = []
    pending.error = undefined
    questionError.hidden = true
    syncContinue()
  })
  questionCustom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  })

  api.onBlock(upsertBlock)
  api.onTurn((turn) => { setRunning(turn?.running === true) })
  api.onSession((id) => { sessionId = typeof id === 'string' ? id : '' })
  api.onHistory((items) => {
    historyItems = Array.isArray(items) ? items : []
    if (historyOpen) renderHistory()
  })
  api.onPermission((preset) => {
    if (typeof preset !== 'string') return
    permission = preset
    renderPermission()
  })
  api.onReset(() => { clearTranscript() })
  api.onAttach((text) => {
    if (typeof text !== 'string' || text === '') return
    const body = clipSelection(text)
    void setExpanded(true).then(() => {
      insertPlainText(prompt, body)
      prompt.focus()
    })
  })
  api.onAvatar((src) => {
    avatarSrc = typeof src === 'string' && src !== '' ? src : 'deepseek-avatar-square.gif'
    const gif = document.querySelector('#ball-gif')
    if (!gif) return
    delete gif.dataset.mode
    syncGif()
  })
  api.onStatus((text) => { status.textContent = typeof text === 'string' ? text : '' })
  api.onQuestion((payload) => { showQuestion(payload) })
  api.onQuestionClear((id) => { clearQuestion(id) })
  api.onQuestionError((payload) => {
    if (pending === undefined || pending.id !== payload?.id) return
    pending.busy = false
    pending.error = typeof payload.text === 'string' ? payload.text : messages.incomplete
    renderQuestion()
  })
  syncGif()
}

main()
