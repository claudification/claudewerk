import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * `globals.css` declares the Tailwind dark variant as CLASS-based:
 *
 *     @custom-variant dark (&:is(.dark *));
 *
 * Nothing in the app ever puts `.dark` on an ancestor. So every `dark:` utility
 * in the codebase was dead, and what actually shipped was each component's
 * LIGHT-mode fallback. That is not a cosmetic detail -- it is why the active
 * tab was painted the page colour while its track was lighter (indicator
 * inverted), why ghost buttons flashed full-strength yellow on hover, and why
 * an unchecked checkbox had no fill.
 *
 * Dead styling is worse than missing styling: it reads as handled.
 *
 * Two ways to satisfy this test: write the state you actually want with no
 * variant, or make the variant real by setting `.dark` on the document. Until
 * something does the latter, `dark:` in a className is a bug.
 */

/* vitest runs with cwd = web/, and import.meta.url does not survive the jsdom
   transform intact -- resolving from cwd is the stable one here. */
const SRC = join(process.cwd(), 'src')
const EXTS = ['.ts', '.tsx']
const SKIP_DIRS = new Set(['node_modules', 'dist', '__snapshots__'])

/** `{ dark: true }` is CodeMirror's theme API, not a Tailwind variant. */
const TAILWIND_DARK = /\bdark:[a-z[]/

/** Comments discuss the dead variants on purpose -- including this file's own. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (EXTS.some(e => entry.endsWith(e)) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx'))
      acc.push(full)
  }
  return acc
}

describe('no dead dark: variants', () => {
  it('the dark variant is still class-based (this test is pointless if it is not)', () => {
    const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8')
    expect(css).toContain('@custom-variant dark (&:is(.dark *))')
  })

  it('no source file uses a dark: utility while no .dark ancestor exists', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = stripComments(readFileSync(file, 'utf8'))
      if (!TAILWIND_DARK.test(text)) continue
      for (const [i, line] of text.split('\n').entries()) {
        if (TAILWIND_DARK.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}`)
      }
    }
    expect(offenders, `dark: utilities never match -- write the state directly:\n${offenders.join('\n')}`).toEqual([])
  })
})
