/**
 * ONE DEFECT, THREE FILES, AND THIS IS THE GATE THAT ENDS IT.
 *
 * A project URI has more than one true spelling. The MCP caller types
 * `claude:///Users/...`, the conversation store holds
 * `claude://default/Users/...`, and pre-2026-04-25 rows still carry the
 * quad-slash concat scar. `isSameProject` (shared/project-uri.ts) is the only
 * comparator that knows this; raw `===` says three spellings of one project are
 * three projects.
 *
 * The epic engine is where that bites, because it is the one subsystem that
 * routinely compares a CALLER's spelling against the STORE's:
 *   - `epic-active.ts`   -- the armed match, fixed in d83e5439
 *   - `epic-sweep-loop`  -- the same filter in `beatOneEpic`, fixed by gen 4
 *   - `epic-inspect.ts`  -- `projectPeers`, fixed here
 * Each was written after the last and inherited the defect anyway, because it
 * was a different file and nothing was watching the shape.
 *
 * WHY A SCOPED TEST AND NOT AN ast-grep RULE. `lint:patterns` scans all of
 * `src/` and `web/src/`, where `x.project === y` is often perfectly correct
 * (both sides already canonical -- `conversation-store.ts`, `shares.ts`,
 * `routes/api.ts`). Its baseline is per-FILE, so silencing those would blind
 * whole god-files to real regressions, and its reporter hard-codes one rule's
 * message. The defect is not "raw project equality anywhere", it is "raw
 * project equality where a caller's spelling meets the store's" -- and that is
 * the epic engine. Scope the gate to where the claim is actually true.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC_DIR = resolve(import.meta.dir, '..')

/** Every non-test `epic-*.ts` under src/, recursively -- broker, shared and the
 *  scanners alike. A test file may legitimately assert on a project string; the
 *  engine may not compare one. */
function epicSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) epicSources(full, out)
    else if (name.startsWith('epic-') && name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** `x.project === y` / `x.project !== y`. `typeof d.project === 'string'` is a
 *  TYPE guard, not a project comparison, and is not what this gate is about. */
const RAW_EQUALITY = /\.project\s*[!=]==/

function offendingLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => RAW_EQUALITY.test(line) && !line.includes('typeof '))
    .map(({ line, no }) => `${file.slice(SRC_DIR.length + 1)}:${no}  ${line.trim()}`)
}

describe('the epic engine compares projects by IDENTITY, never by raw string', () => {
  test('no epic source compares .project with === or !==', () => {
    const hits = epicSources(SRC_DIR).flatMap(offendingLines)
    expect(hits).toEqual([])
  })

  test('the scan actually reaches the files it claims to guard', () => {
    const names = epicSources(SRC_DIR).map(f => f.slice(SRC_DIR.length + 1))
    expect(names).toContain('broker/epic-inspect.ts')
    expect(names).toContain('broker/epic-active.ts')
    expect(names.length).toBeGreaterThan(10)
  })
})
