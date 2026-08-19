#!/usr/bin/env bun
/**
 * gen-isolated-tests.ts - list the test files that must keep their own module
 * registry, by the pattern that makes them fragile rather than by which ones
 * happened to fail today.
 *
 * Running the web suite with `isolate: false` costs 80 CPU-seconds instead of
 * 207, because a worker then reuses one module graph across every file it runs.
 * That reuse is also what breaks tests, and the breakage is order-dependent:
 * across four runs the failing set was 7, 3, 4 and 3 files, union 13, still
 * growing. A denylist built from observed failures would therefore be both
 * incomplete and unstable.
 *
 * The pattern behind it is not. Every failure traced to a file that either:
 *
 *   1. calls `vi.mock()` and then binds its subject with a TOP-LEVEL
 *      `await import()`. That binding happens once, at file load. Reuse the
 *      registry and the binding points at a module graph some earlier file
 *      already mocked -- or worse, mocked differently.
 *
 *   2. reads or writes a module-level store singleton (`useXStore.setState`).
 *      Two files sharing a registry share that store, so whichever runs second
 *      inherits the first one's state.
 *
 * Both are greppable, which is the point: this list can be regenerated and
 * checked, so a newly-added fragile file fails the check instead of silently
 * joining the flaky pool months later.
 *
 *   bun scripts/gen-isolated-tests.ts           # print the list
 *   bun scripts/gen-isolated-tests.ts --write   # write web/vitest-isolated.json
 *   bun scripts/gen-isolated-tests.ts --check    # exit 1 if the file is stale
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const WEB_SRC = join(import.meta.dir, '..', 'web', 'src')
const MANIFEST = join(import.meta.dir, '..', 'web', 'vitest-isolated.json')

const STORE_SINGLETON = /\buse[A-Za-z]*Store\.(setState|getState)/

function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, found)
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

/**
 * Isolate every file that can POLLUTE a shared registry -- every mocker, every
 * store toucher -- not the files observed to break.
 *
 * A narrower rule was tried first: `vi.mock` AND a top-level `await import`,
 * on the theory that the load-time binding was what made a file fragile. Six
 * stability runs killed it. Run 3 failed two files, and neither was catchable
 * that way: `partial-banner.test.tsx` mocks with plain static imports, and
 * `use-save-schedule.test.tsx` has no mock, no await-import and no store
 * access whatsoever -- it was a pure VICTIM of a mock some other file leaked.
 *
 * That is the whole lesson. A victim is not identifiable by anything in its own
 * source, so the victim set cannot be enumerated at all. The leaker set can.
 * Quarantine every leaker and the shared pool has nothing left to poison it.
 */
function needsIsolation(source: string): boolean {
  return source.includes('vi.mock(') || STORE_SINGLETON.test(source)
}

const fragile = testFiles(WEB_SRC)
  .filter(f => needsIsolation(readFileSync(f, 'utf8')))
  .map(f => relative(join(import.meta.dir, '..', 'web'), f))
  .sort()

const flags = process.argv.slice(2)
const serialized = `${JSON.stringify(fragile, null, 2)}\n`

if (flags.includes('--write')) {
  writeFileSync(MANIFEST, serialized)
  console.error(`wrote ${fragile.length} paths to web/vitest-isolated.json`)
} else if (flags.includes('--check')) {
  const current = readFileSync(MANIFEST, 'utf8')
  if (current !== serialized) {
    console.error('web/vitest-isolated.json is stale -- run: bun scripts/gen-isolated-tests.ts --write')
    console.error('A test file gained or lost the pattern that requires its own module registry.')
    process.exit(1)
  }
  console.error(`web/vitest-isolated.json is current (${fragile.length} paths)`)
} else {
  for (const f of fragile) console.log(f)
  console.error(`${fragile.length} of ${testFiles(WEB_SRC).length} files need isolation`)
}
