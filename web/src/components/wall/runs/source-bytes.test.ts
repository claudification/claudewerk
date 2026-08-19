/**
 * REGRESSION (2026-08-20): `use-unattended-runs.ts` shipped with five NUL bytes
 * where the spaces inside three template literals should have been, so every row
 * key was `epic<NUL><project><NUL><epicId>`. Git classified the file as BINARY
 * and refused to diff it -- which is how it was noticed at all.
 *
 * EVERY OTHER GATE PASSED IT. `tsc` reads NUL as ordinary string content, biome
 * formatted around it, all three vitest suites went green, and the production
 * bundle built. A byte nothing can see and nothing checks is exactly the kind
 * that survives to production, so this suite is the check: no C0 control
 * character (other than the tab, newline and carriage return that structure a
 * file) may appear in this pane's source.
 *
 * THE SCAN IS NUMERIC, with no character class and no escape anywhere in this
 * file. That is not style: a regex written with escapes is one editor round trip
 * away from holding the very bytes it rejects, at which point the test can no
 * longer pass on itself. Comparing code points cannot go wrong that way.
 *
 * Cheap, and it covers the whole pane rather than the one literal that broke.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TAB = 9
const LF = 10
const CR = 13
const SPACE = 32
const DEL = 127

function hasControlByte(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === TAB || code === LF || code === CR) continue
    if (code < SPACE || code === DEL) return true
  }
  return false
}

/**
 * This directory plus the pane file, resolved off the RUNNING TEST'S OWN PATH.
 * Neither `process.cwd()` (whatever shell launched vitest) nor `import.meta.url`
 * (rewritten by the transform) survives; the test path does.
 */
function paneSources(here: string): string[] {
  const own = readdirSync(here)
    .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map(f => join(here, f))
  return [...own, join(here, '..', 'panes', 'a7-unattended-runs.tsx')]
}

describe('A7 source bytes', () => {
  it('carries no invisible control characters', () => {
    const here = dirname(String(expect.getState().testPath))
    const dirty = paneSources(here).filter(path => hasControlByte(readFileSync(path, 'utf8')))
    expect(dirty).toEqual([])
  })
})
