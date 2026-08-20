/**
 * Shiki syntax highlighting - static imports for core + eager langs,
 * lazy imports only for rare languages.
 *
 * SUBPATH COVENANT: grammars and themes come from `@shikijs/langs` and
 * `@shikijs/themes`, NOT from `shiki/langs/*` or `shiki/themes/*`. shiki 4's
 * exports map has no per-file entry for either -- just the catch-all
 * `"./*": "./dist/*"`, which resolves to an extensionless path. Vite retries
 * extensions and links fine; bun obeys the map literally and cannot find the
 * module, so `shiki/themes/tokyo-night` took the whole test suite down while
 * the shipped bundle stayed green. `shiki/core` and `shiki/engine/javascript`
 * ARE real exports-map entries and stay as they are. Pinned by
 * `syntax-subpath.test.ts`.
 */

import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import tokyoNight from '@shikijs/themes/tokyo-night'

// LAZY-LOAD COVENANT: the default ("eager") grammar packs (js/ts/tsx/jsx/sh)
// are ~775KB of grammar JSON. Statically importing them parked that data in
// the eager index chunk even though `getHighlighter()` -- already an async
// deferred singleton -- is the only consumer, and it never runs until the
// first code block paints. Loading them via dynamic import() moves the whole
// blob to an async chunk that travels with the highlighter. No new UX cost:
// every call site already awaits getHighlighter(), so the await already exists.
const loadDefaultLangs = () =>
  Promise.all([
    import('@shikijs/langs/javascript'),
    import('@shikijs/langs/typescript'),
    import('@shikijs/langs/tsx'),
    import('@shikijs/langs/jsx'),
    import('@shikijs/langs/shellscript'),
  ]).then(mods => mods.flatMap(m => m.default))

// Lazy singleton highlighter
let highlighterPromise: Promise<HighlighterCore> | null = null

// Languages available for lazy loading (less common)
const LAZY_LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  html: () => import('@shikijs/langs/html'),
  astro: () => import('@shikijs/langs/astro'),
  css: () => import('@shikijs/langs/css'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  sass: () => import('@shikijs/langs/sass'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  json5: () => import('@shikijs/langs/json5'),
  xml: () => import('@shikijs/langs/xml'),
  toml: () => import('@shikijs/langs/toml'),
  mdx: () => import('@shikijs/langs/mdx'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  php: () => import('@shikijs/langs/php'),
  r: () => import('@shikijs/langs/r'),
  coffee: () => import('@shikijs/langs/coffee'),
  pug: () => import('@shikijs/langs/pug'),
  handlebars: () => import('@shikijs/langs/handlebars'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
}

// All known language IDs (eager + lazy)
const ALL_LANGS = new Set(['javascript', 'typescript', 'tsx', 'jsx', 'shellscript', ...Object.keys(LAZY_LANG_LOADERS)])

// Common aliases users / markdown fences use, mapped to canonical shiki IDs.
// Returns the canonical id, or `undefined` if we don't support it (caller falls back to plain text).
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  cs: 'csharp',
  'c#': 'csharp',
  md: 'markdown',
  yml: 'yaml',
  hpp: 'cpp',
  h: 'cpp',
  htm: 'html',
  svg: 'xml',
  kt: 'kotlin',
  hbs: 'handlebars',
  gql: 'graphql',
  docker: 'dockerfile',
}

export function normalizeLang(lang: string | undefined | null): string | undefined {
  if (!lang) return undefined
  const lower = lang.toLowerCase()
  const canonical = LANG_ALIASES[lower] || lower
  return ALL_LANGS.has(canonical) ? canonical : undefined
}

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = loadDefaultLangs().then(langs =>
      createHighlighterCore({
        themes: [tokyoNight],
        langs,
        engine: createJavaScriptRegexEngine(),
      }),
    )
  }
  return highlighterPromise
}

// Lazy-load a language into the highlighter if not already loaded
export async function ensureLang(lang: string): Promise<boolean> {
  if (!ALL_LANGS.has(lang)) return false
  const hl = await getHighlighter()
  const loaded = hl.getLoadedLanguages() as string[]
  if (loaded.includes(lang)) return true
  const loader = LAZY_LANG_LOADERS[lang]
  if (!loader) return false
  try {
    const mod = (await loader()) as { default: unknown[] }
    await hl.loadLanguage(...(mod.default as Parameters<typeof hl.loadLanguage>))
    return true
  } catch {
    return false
  }
}

// File extension -> shiki language id
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sass: 'sass',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'mdx',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  php: 'php',
  r: 'r',
  coffee: 'coffee',
  pug: 'pug',
  hbs: 'handlebars',
  dockerfile: 'dockerfile',
  swift: 'swift',
  kt: 'kotlin',
  lua: 'lua',
}

export function langFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? EXT_TO_LANG[ext] : undefined
}
