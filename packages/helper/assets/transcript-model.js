// Reasoning summaries and turn-process labels, matching Harness ReasoningRow and message-chrome.

function firstLine(text) {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestCompletedParagraphFirstLine(text) {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatDuration(ms, zh, live) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const secondText = live || (hours === 0 && minutes === 0) ? String(seconds) : pad2(seconds)
  const minuteText = !live && hours === 0 ? String(minutes) : hours > 0 ? pad2(minutes) : String(minutes)
  if (hours > 0) {
    return zh
      ? `${hours}小时${minuteText}分${secondText}秒`
      : `${hours}h ${minuteText}m ${secondText}s`
  }
  if (minutes > 0) return zh ? `${minutes}分${secondText}秒` : `${minutes}m ${secondText}s`
  return zh ? `${secondText}秒` : `${secondText}s`
}

export function reasoningSummary(text, running) {
  if (typeof text !== 'string') return ''
  const summary = running ? latestCompletedParagraphFirstLine(text) : firstLine(text)
  return summary.replaceAll('**', '')
}

export function processLabel({ zh, running, elapsedMs }) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) {
    if (running) return zh ? '深度求索中' : 'Deep diving...'
    return zh ? '已思考' : 'Thought for a while'
  }
  const duration = formatDuration(Math.max(1000, elapsedMs), zh === true, running === true)
  if (running) return zh ? `深度求索中，用时${duration}` : `Deep diving for ${duration}`
  return zh ? `用时 ${duration}` : `Took ${duration}`
}
