/** Transcript markdown. No links, because the ball window refuses navigation. */

export function renderMarkdown(text) {
  const source = typeof text === 'string' ? text : ''
  const html = []
  const parts = source.split(/```/)
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const body = part.replace(/^[^\n]*\n/, '')
      html.push(`<pre><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`)
      return
    }
    if (part !== '') html.push(renderFlow(part))
  })
  return html.join('')
}

function renderFlow(text) {
  const lines = text.split('\n')
  const html = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (/^#{1,6}\s+\S/.test(line)) {
      html.push(`<p><strong>${renderInline(line.replace(/^#{1,6}\s+/, ''))}</strong></p>`)
      index += 1
      continue
    }
    if (/^[-*]\s+\S/.test(line)) {
      const items = []
      while (index < lines.length && /^[-*]\s+\S/.test(lines[index] ?? '')) {
        items.push(`<li>${renderInline((lines[index] ?? '').replace(/^[-*]\s+/, ''))}</li>`)
        index += 1
      }
      html.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\d+\.\s+\S/.test(line)) {
      const items = []
      while (index < lines.length && /^\d+\.\s+\S/.test(lines[index] ?? '')) {
        items.push(`<li>${renderInline((lines[index] ?? '').replace(/^\d+\.\s+/, ''))}</li>`)
        index += 1
      }
      html.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    if (line.trim() === '') {
      index += 1
      continue
    }
    const paragraph = []
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim() === '' || isBlockStart(next)) break
      paragraph.push(next)
      index += 1
    }
    html.push(`<p>${paragraph.map((item) => renderInline(item)).join('<br>')}</p>`)
  }
  return html.join('')
}

function isBlockStart(line) {
  return /^#{1,6}\s+\S/.test(line) || /^[-*]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line)
}

function renderInline(text) {
  return text.split(/(`[^`]+`)/).map((part, index) => {
    if (index % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`
    return escapeHtml(part)
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, url) => `${label} (${url})`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  }).join('')
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}
