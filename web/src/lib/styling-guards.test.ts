import { readdirSync, readFileSync, statSync } from 'node:fs'
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

/**
 * Opacity is not a colour token.
 *
 * `text-muted-foreground/40` measured 2.08:1 against the page -- under every
 * WCAG floor and simply not readable. There were 628 of these, plus 239 faded
 * borders where `border-border/30` came out at 1.10:1, i.e. an invisible
 * divider. The alpha was standing in for tokens that did not exist.
 *
 * They exist now: --fg-muted / --fg-dim / --fg-faint, and --border-subtle.
 * Use them. An alpha suffix hides the contrast from anyone reading the class,
 * which is how 628 illegible sites accumulated without anyone noticing.
 *
 * Exception: `/0` is not faded text, it is HIDDEN text revealed on hover.
 */
const STACKED_TEXT = /\btext-muted-foreground\/(?!0\b)\d+/
const STACKED_BORDER = /\bborder(-[trblxyse])?-border\/\d+/

function scan(pattern: RegExp): string[] {
  const offenders: string[] = []
  for (const file of sourceFiles(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    if (!pattern.test(text)) continue
    for (const [i, line] of text.split('\n').entries()) {
      if (pattern.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}`)
    }
  }
  return offenders
}

describe('no opacity-stacked colour tokens', () => {
  it('foreground text uses a real token, not an alpha suffix', () => {
    const offenders = scan(STACKED_TEXT)
    expect(offenders, `use text-fg-muted / text-fg-dim / text-fg-faint:\n${offenders.join('\n')}`).toEqual([])
  })

  it('borders use a real weight, not an alpha suffix', () => {
    const offenders = scan(STACKED_BORDER)
    expect(
      offenders,
      `use border-border-subtle / border-border / border-border-strong:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

/**
 * `--primary-foreground` means "text that sits ON a primary-coloured fill".
 * It is defined by its BACKGROUND, so its value flips whenever that background
 * does -- it went from near-white to near-black when primary buttons got a
 * bright fill.
 *
 * A chat bubble is a user-chosen saturated colour, not a primary surface. It
 * borrowed the token anyway, and rode on it happening to be near-white. The
 * moment it flipped, every link and inline code chip inside a bubble turned
 * dark-on-colour. The bubble's own text is `text-white`, and so is its
 * conversation-pill override; the two that said `primary-foreground` were the
 * odd ones out.
 */
/**
 * ONE `::selection` rule, and it does not paint with `--primary-foreground`.
 *
 * globals.css carried two, ~80 lines apart. The later one won, so selected text
 * everywhere was `--primary-foreground` on `--primary` -- and when that token
 * flipped near-white to near-black (so labels could sit on a bright primary
 * fill) every selection in the app became dark text on blue. The first rule
 * looked correct the whole time, which is exactly why the duplicate was so hard
 * to see: reading the file top-down, you find a right answer and stop.
 *
 * It also hit CodeMirror, which paints its own selection layer but leaves the
 * native `::selection` to colour the text on top.
 */
describe('exactly one ::selection rule', () => {
  const css = () => readFileSync(join(SRC, 'styles/globals.css'), 'utf8')

  it('is declared once', () => {
    const blocks = stripComments(css()).match(/(^|[\s,])::selection\s*[,{]/g) ?? []
    expect(blocks.length, 'a second ::selection later in the file silently wins').toBe(1)
  })

  it('does not paint selected text with a token defined by a button fill', () => {
    const rule = /::selection[^{]*\{[^}]*\}/g
    for (const block of stripComments(css()).match(rule) ?? []) {
      expect(block, 'primary-foreground flips with the primary FILL').not.toContain('primary-foreground')
    }
  })
})

describe('chat bubbles do not borrow --primary-foreground', () => {
  it('a bubble is not a primary surface, so it uses white directly', () => {
    const bubble = readFileSync(join(SRC, 'components/transcript/chat-bubble.tsx'), 'utf8')
    const offenders = stripComments(bubble)
      .split('\n')
      .map((line, i) => [line, i + 1] as const)
      .filter(([line]) => line.includes('primary-foreground'))
      .map(([, n]) => `chat-bubble.tsx:${n}`)
    expect(offenders, `use text-white -- the token flips with the primary FILL:\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('no dead dark: variants', () => {
  it('the dark variant is still class-based (this test is pointless if it is not)', () => {
    const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8')
    expect(css).toContain('@custom-variant dark (&:is(.dark *))')
  })

  it('no source file uses a dark: utility while no .dark ancestor exists', () => {
    const offenders = scan(TAILWIND_DARK)
    expect(offenders, `dark: utilities never match -- write the state directly:\n${offenders.join('\n')}`).toEqual([])
  })
})
