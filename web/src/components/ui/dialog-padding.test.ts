/**
 * Every <DialogContent> must state its padding explicitly.
 *
 * The incident (2026-08-14): the vacuum APPLY confirm rendered with its title
 * and body text jammed flush against all four edges. Cause -- this repo's
 * `DialogContent` applies NO padding of its own. Upstream shadcn/ui ships
 * `p-6 gap-4` there; this variant deliberately dropped it so modals can run
 * headers and panes edge-to-edge.
 *
 * That makes padding opt-IN, and forgetting it fails silently: nothing warns,
 * the dialog just looks broken. Jonas has hit it on repeated new modals, which
 * is what makes it worth a test rather than another fix -- anyone writing a
 * dialog from shadcn muscle memory reintroduces it.
 *
 * The rule is "say what you mean", not "always pad". `p-0` is an entirely valid
 * answer and the dominant local idiom (the dialog pads its own sections so a
 * header or footer can carry a full-bleed background). What is NOT valid is
 * leaving it unstated and inheriting nothing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', '..')

/** Any explicit padding declaration, including the deliberate `p-0`. */
const PADDING = /\b(p|px|py|pt|pb|pl|pr)-(0|px|\d+(\.\d+)?|\[[^\]]+\])/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') sourceFiles(path, out)
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(path)
    }
  }
  return out
}

/** How far past the opening tag to look for a padded wrapper. Enough to cover
 *  the first child element's className, not enough to reach a nested section
 *  that pads itself for unrelated reasons. */
const CHILD_WINDOW = 220

interface Usage {
  /** The opening tag, flattened to one line. */
  tag: string
  /** True when the tag OR its immediate wrapper declares padding. */
  padded: boolean
}

/** Every `<DialogContent ...>` usage, with whether padding is declared.
 *
 *  Deliberately naive -- it only has to find the tag, read its props, and peek
 *  at the first child. A real parser here would be more machinery than the rule
 *  is worth.
 *
 *  The first-child peek is what keeps this honest: several dialogs correctly
 *  leave DialogContent bare and pad a wrapper div instead (shortcut-help wraps
 *  everything in `<div className="font-mono p-6">`). Flagging those would make
 *  the test cry wolf, and a test that cries wolf gets ignored -- which would
 *  cost exactly the protection this one exists to give. */
function dialogContentUsages(source: string): Usage[] {
  const usages: Usage[] = []
  const re = /<DialogContent\b/g
  let match = re.exec(source)
  while (match) {
    // Walk to the closing '>' of this opening tag, tracking brace depth so a
    // `className={cn(...)}` containing '>' cannot end it early.
    let depth = 0
    let i = match.index
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    const tag = source.slice(match.index, i + 1).replace(/\s+/g, ' ')
    const child = source.slice(i + 1, i + 1 + CHILD_WINDOW)
    usages.push({ tag, padded: PADDING.test(tag) || PADDING.test(child) })
    match = re.exec(source)
  }
  return usages
}

describe('DialogContent padding is always explicit', () => {
  const offenders: string[] = []
  let checked = 0

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf-8')
    if (!source.includes('<DialogContent')) continue
    for (const usage of dialogContentUsages(source)) {
      checked++
      if (!usage.padded) offenders.push(`${file.slice(SRC.length + 1)}: ${usage.tag.slice(0, 120)}`)
    }
  }

  it('finds DialogContent usages to check (guards a silently empty sweep)', () => {
    expect(checked).toBeGreaterThan(10)
  })

  it('every DialogContent declares padding (p-0 counts -- unstated does not)', () => {
    expect(
      offenders,
      `DialogContent ships NO default padding in this repo, so these render flush to the edges.\n` +
        `Add "p-0" and pad the inner sections (the local idiom), or an explicit "p-4".\n\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
