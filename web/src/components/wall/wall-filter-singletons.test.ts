/**
 * @vitest-environment node
 */

/**
 * ONE PARSER, ONE MATCHER, ONE CHIP ACTION -- greped, not assumed.
 *
 * Thirteen panes wire the shared filter from thirteen files, and the cheapest
 * way for any one of them to "fix" a mismatch is to write its own little parse
 * or its own little toggle. That fork is invisible in a rendering test: both
 * copies agree on the day they are written and drift the week after, and then
 * two panes disagree about what `@anvil-md` means with every test still green.
 *
 * `wall-chip-capture.ts` exists BECAUSE this already happened once: P1 and P2
 * grew the identical chip handler on branches that were open at the same time,
 * so neither werk-worker could have seen the other's copy. The counts below are
 * the check that would have caught it.
 *
 * A source scan is the right instrument here precisely because it does not run
 * the code. "There is exactly one of these in the tree" is a fact about the
 * TREE, and no amount of rendering can establish it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/* vitest runs with cwd = web/, the same resolution `styling-guards.test.ts`
   settled on: `import.meta.url` does not survive the transform intact. */
const SRC = join(process.cwd(), 'src')
const SKIP_DIRS = new Set(['node_modules', 'dist', '__snapshots__'])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/** Files whose source DEFINES the thing (not ones that merely mention it). */
function definedIn(pattern: RegExp): string[] {
  return sourceFiles(SRC)
    .filter(path => pattern.test(readFileSync(path, 'utf8')))
    .map(path => relative(SRC, path))
    .sort()
}

describe('the filter substrate is a singleton', () => {
  it('has exactly ONE parser, and the wall re-exports rather than forks it', () => {
    // A DEFINITION, not a call: `parseWallQuery = parsePulseQuery` in the wall's
    // `query.ts` is an alias and must not count as a second parser.
    expect(definedIn(/^export function parsePulseQuery\b/m)).toEqual(['lib/pulse/query-parse.ts'])

    // ...and the wall's name for it is that alias, spelled out. A wall-side
    // `function parseWallQuery(raw) { ... }` would be the fork this line refuses.
    const wallQuery = readFileSync(join(SRC, 'lib/wall/query.ts'), 'utf8')
    expect(wallQuery).toMatch(/export const parseWallQuery: \(raw: string\) => WallQuery = parsePulseQuery/)
    expect(definedIn(/^export function parseWallQuery\b/m)).toEqual([])
  })

  it('has exactly ONE matcher, and the wall wrapper delegates to it', () => {
    expect(definedIn(/^export function matchesPulseQuery\b/m)).toEqual(['lib/pulse/query-match.ts'])

    // `matchesWallRow` is allowed to exist -- it fills a PARTIAL row out to what
    // the matcher expects -- but it must decide nothing. If it ever stops calling
    // the one matcher, it has become a second one.
    expect(definedIn(/^export function matchesWallRow\b/m)).toEqual(['lib/wall/query.ts'])
    expect(readFileSync(join(SRC, 'lib/wall/query.ts'), 'utf8')).toMatch(/return matchesPulseQuery\(/)
  })

  it('has exactly ONE chip action, in the store, and one way into it', () => {
    // The action itself: "scope to this project, or clear it if it already is the
    // scope". Nine panes render a project dot and none of them may own this.
    expect(definedIn(/^ {2}toggleProject: project =>/m)).toEqual(['lib/wall/filter-store.ts'])
    // The token arithmetic behind it, likewise once.
    expect(definedIn(/^export function toggledProject\b/m)).toEqual(['lib/wall/project-token.ts'])
    // And the capture-phase delegate the row-based panes share.
    expect(definedIn(/^export function handleChipCapture\b/m)).toEqual(['components/wall/wall-chip-capture.ts'])
  })

  it('lets no pane match a row behind the axis stripping', () => {
    // `useWallFilter` is the one hook, and going around it is the failure mode
    // that matters: a pane calling the matcher directly would run the WHOLE query
    // against its rows, including axes it has no facet for, and go blank for a
    // constraint it does not understand. That is precisely what `axes.ts` exists
    // to make unexpressible, and it only holds while this hook is the only door.
    expect(definedIn(/^export function useWallFilter</m)).toEqual(['lib/wall/use-wall-filter.ts'])

    // Four files may name a matcher: the one that DEFINES it, the wall's
    // partial-row wrapper, the hook, and Pulse's own feed -- the grammar's home
    // surface, which predates the wall. A fifth entry is a pane that let itself
    // around the axes.
    expect(definedIn(/\bmatches(Pulse|Wall)(Query|Row)\(/)).toEqual([
      'components/pulse/use-pulse-fleet.ts',
      'lib/pulse/query-match.ts',
      'lib/wall/query.ts',
      'lib/wall/use-wall-filter.ts',
    ])
  })
})
