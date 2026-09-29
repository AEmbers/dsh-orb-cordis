import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../assets/markdown.js'

describe('transcript markdown', () => {
  it('renders headings, lists, fenced code, bold, and link text', () => {
    const html = renderMarkdown('# Title\n\n- a\n- b\n\n1. c\n\n```\n<tag>\n```\n\nsee [docs](https://example.com) and **bold**')
    assert.match(html, /<p><strong>Title<\/strong><\/p>/)
    assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/)
    assert.match(html, /<ol><li>c<\/li><\/ol>/)
    assert.match(html, /<pre><code>&lt;tag&gt;<\/code><\/pre>/)
    assert.equal(html.includes('<a'), false)
    assert.match(html, /docs \(https:\/\/example.com\)/)
    assert.match(html, /<strong>bold<\/strong>/)
  })

  it('does not format markup that sits inside inline code', () => {
    const html = renderMarkdown('use `**<b>` please')
    assert.equal(html.includes('<strong>'), false)
    assert.match(html, /<code>\*\*&lt;b&gt;<\/code>/)
  })
})
