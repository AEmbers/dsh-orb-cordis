/**
 * Browser vendor bundle: the client's ONE syntax highlighter, ported from
 * ui-primitives src/markdown/highlight.ts — synchronous fine-grained shiki
 * core (JavaScript regex engine, no WASM) with an explicit grammar allowlist
 * and a CSS-variables theme. Token colors resolve through `--shiki-*`
 * custom properties carried by the theme package's sheets (theme.css), so
 * light/dark follows the page cascade. Built to assets/vendor/shiki.js by
 * `pnpm --filter @dsh-orb/helper build:vendor`.
 */

import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'

const LANGS = [langTs, langBash, langJson]

const LAZY_GRAMMARS = new Map([
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['kotlin', () => import('@shikijs/langs/kotlin')],
  ['swift', () => import('@shikijs/langs/swift')],
  ['php', () => import('@shikijs/langs/php')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['less', () => import('@shikijs/langs/less')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
])

const LANG_ALIASES = new Map([
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['javascript', 'typescript'],
  ['js', 'typescript'],
  ['jsx', 'typescript'],
  ['shellscript', 'shellscript'],
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['zsh', 'shellscript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['php', 'php'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['lua', 'lua'],
])

const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: pattern => defaultJavaScriptRegexConstructor(pattern, {
    lazyCompileLength: Number.POSITIVE_INFINITY,
  }),
})

type HighlighterInstance = ReturnType<typeof createHighlighterCoreSync>

let singleton: HighlighterInstance | undefined
const requested = new Set<string>()
const listeners = new Set<() => void>()

function createHighlighter() {
  return createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: regexEngine,
  })
}

function highlighter() {
  singleton ??= createHighlighter()
  return singleton
}

const warmup = setTimeout(() => { highlighter() }, 0)
if (typeof warmup.unref === 'function') warmup.unref()

function ensureGrammar(resolved: string): boolean {
  const load = LAZY_GRAMMARS.get(resolved)
  if (load === undefined) return true
  if (highlighter().getLoadedLanguages().includes(resolved)) return true
  if (!requested.has(resolved)) {
    requested.add(resolved)
    load().then((mod) => {
      highlighter().loadLanguageSync(mod.default)
      for (const listener of listeners) listener()
    }, () => {
      // An unloadable grammar stays plain, exactly like an unknown language.
    })
  }
  return false
}

/** Shiki HTML for `code`, or undefined when the language is unknown or its grammar is still loading. */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = lang === undefined || lang === '' ? undefined : LANG_ALIASES.get(String(lang).toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  return highlighter().codeToHtml(code, { lang: resolved, theme: 'css-variables' })
}

export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
