/**
 * @vitest-environment node
 */
/**
 * shiki 4 stopped publishing per-file subpaths, and only one of our two
 * resolvers cares.
 *
 * `shiki@4.4.3`'s exports map has no `./themes/*` and no `./langs/*` entry --
 * just the catch-all `"./*": "./dist/*"`. So `shiki/themes/tokyo-night`
 * resolves to `dist/themes/tokyo-night` with NO extension. The `.mjs` file is
 * right there on disk, so Vite (which retries extensions) links a perfectly
 * good bundle and the panel highlights code fine. Bun's resolver obeys the map
 * literally and reports `Cannot find module`.
 *
 * That divergence is the whole hazard: the specifier is already wrong today and
 * nothing in the shipped product says so. The day Vite tightens its exports
 * handling -- or anyone points bun at a file under `web/` -- ~40 import sites
 * break at once, in a module that only ever fails at runtime.
 *
 * The per-file subpaths DO exist, properly declared, on shiki's own upstream
 * packages `@shikijs/themes` and `@shikijs/langs`. This test pins all three
 * halves of that fix: nobody reintroduces the broken specifier, the packages
 * are DECLARED rather than borrowed from shiki's transitive tree, and the
 * highlighter it all feeds actually paints.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ensureLang, getHighlighter } from './syntax'

const WEB = join(import.meta.dirname, '..', '..', '..')
const SRC = join(WEB, 'src')

/** `shiki/themes/<name>` or `shiki/langs/<name>` -- the subpaths shiki 4 dropped. */
const DROPPED_SUBPATH = /['"]shiki\/(themes|langs)\/[^'"]+['"]/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') sourceFiles(path, out)
    } else if (/\.tsx?$/.test(entry) && !entry.includes('syntax-subpath.test')) {
      out.push(path)
    }
  }
  return out
}

describe('the shiki subpaths we are allowed to import', () => {
  test('no source file imports a per-file `shiki/themes/*` or `shiki/langs/*` path', () => {
    const offenders = sourceFiles(SRC)
      .filter(f => DROPPED_SUBPATH.test(readFileSync(f, 'utf8')))
      .map(f => f.slice(WEB.length + 1))

    expect(offenders, 'import these from @shikijs/themes and @shikijs/langs -- shiki 4 dropped the subpaths').toEqual(
      [],
    )
  })

  test('the packages we import from are declared dependencies, not borrowed transitives', () => {
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'))
    expect(Object.keys(pkg.dependencies)).toEqual(expect.arrayContaining(['@shikijs/langs', '@shikijs/themes']))
  })
})

describe('the highlighter those imports feed', () => {
  test('loaded a real theme, not a lazy bundle map', async () => {
    const hl = await getHighlighter()
    expect(hl.getLoadedThemes()).toContain('tokyo-night')
  })

  test('loaded the eager grammar packs', async () => {
    const hl = await getHighlighter()
    expect(hl.getLoadedLanguages()).toEqual(
      expect.arrayContaining(['javascript', 'typescript', 'tsx', 'jsx', 'shellscript']),
    )
  })

  test('resolves a lazily-loaded grammar too', async () => {
    expect(await ensureLang('json')).toBe(true)
    expect((await getHighlighter()).getLoadedLanguages()).toContain('json')
  })

  test('actually paints with the theme it loaded', async () => {
    const hl = await getHighlighter()
    expect(hl.codeToHtml('const x = 1', { lang: 'typescript', theme: 'tokyo-night' })).toContain('<span')
  })
})
