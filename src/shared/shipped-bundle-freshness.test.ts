/**
 * The shipped bundles must know every frontmatter verb the source does.
 *
 * WHY THIS EXISTS (2026-08-15): the EPICS view showed every epic as childless
 * and `UNPARENTED 381 cards` on a board where 20 cards carried `epic:`. Nothing
 * was wrong with the view. The SENTINEL owns board file I/O, and the shipped
 * sentinel bundle had been built 29 minutes BEFORE epic support landed, so
 * `readLinkage` in that binary had never heard of the key. Every card crossed
 * the wire with `epic: undefined` and the panel faithfully drew the result.
 *
 * It cost an hour chasing frontend code that was correct the whole time.
 *
 * The guard is CAPABILITY-based, not mtime-based, on purpose. An mtime check
 * ("bundle older than newest source") goes red on every ordinary source edit
 * and gets muted within a week. This asks the narrower question that actually
 * predicts the failure: does the binary contain the vocabulary?
 *
 * A minified bun bundle keeps string literals, so a registered verb that the
 * bundle cannot match is a verb that bundle cannot read.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LINKAGE_VERBS } from './card-linkage'

/**
 * Bundles are gitignored build artifacts, so they live in the MAIN working tree
 * even when this test runs from a worktree. `--git-common-dir` points at the
 * shared `.git` in both cases; its parent is the tree that holds `bin/`.
 */
function mainWorktreeRoot(): string {
  const fallback = join(import.meta.dir, '..', '..')
  try {
    const git = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: fallback })
    const out = git.stdout.toString().trim()
    return out ? dirname(out) : fallback
  } catch {
    return fallback
  }
}

const REPO_ROOT = mainWorktreeRoot()

/** Bundles that parse board cards. An agent host that never touches the board
 *  is not required to carry the vocabulary. */
const BOARD_READING_BUNDLES = ['packages/sentinel/bin/sentinel', 'bin/sentinel']

function readBundle(relPath: string): string | null {
  const full = join(REPO_ROOT, relPath)
  if (!existsSync(full)) return null
  return readFileSync(full, 'latin1')
}

describe('shipped bundle freshness', () => {
  const present = BOARD_READING_BUNDLES.filter(p => existsSync(join(REPO_ROOT, p)))

  it('finds at least one board-reading bundle to check', () => {
    // If this fails nothing has been built yet, which is a legitimate state --
    // but a silently-empty guard is how this class of bug got through once.
    expect(present.length).toBeGreaterThan(0)
  })

  for (const relPath of present) {
    it(`${relPath} knows every registered linkage verb`, () => {
      const bundle = readBundle(relPath)
      expect(bundle).not.toBeNull()

      const missing = LINKAGE_VERBS.map(v => v.key).filter(key => !(bundle as string).includes(key))

      expect({
        bundle: relPath,
        missing,
        fix: missing.length > 0 ? 'bun run build:packages, then restart the sentinel' : 'none',
      }).toEqual({ bundle: relPath, missing: [], fix: 'none' })
    })
  }
})
