/**
 * REGRESSION GUARD for the "Export named 'noteCapacityUsageEvent' not found in
 * module" failures that only appeared once `bun test` was given more than one
 * directory (`src/broker/handlers src/broker/routes` -> 4 files down, every
 * single-directory run green).
 *
 * Cause: `mock.module()` is process-global and permanent in Bun. A factory that
 * returns a partial module -- `routes/nightshift.test.ts` returned 2 of this
 * module's exports -- deletes the rest for every file LINKED afterwards in the
 * same process. `handlers/transcript.ts` imports `noteCapacityUsageEvent` from
 * `nightshift-orchestrator`, so it failed to link, and took its 4 test files with
 * it. Nothing to do with an import cycle: there is no runtime import path from
 * `nightshift-orchestrator` back into `handlers/`.
 *
 * Two assertions, because the bug has two halves:
 *  1. no test file may `mock.module` this module again (use
 *     `configureNightshiftRunner` / `configureNightshiftIo` instead)
 *  2. the export surface actually resolves from an importer -- the symptom itself
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BROKER_DIR = import.meta.dir

/** Every `.test.ts` under src/broker, recursively. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) testFiles(full, out)
    else if (name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('nightshift-orchestrator must never be module-mocked', () => {
  test('no test file calls mock.module on it', () => {
    // Matches mock.module('<anything>/nightshift-orchestrator') regardless of how
    // deep the relative specifier is.
    const offender = /mock\.module\(\s*['"][^'"]*nightshift-orchestrator['"]/
    const hits = testFiles(BROKER_DIR)
      .filter(f => f !== import.meta.path) // this file quotes the banned shape on purpose
      .filter(f => offender.test(readFileSync(f, 'utf8')))
      .map(f => f.slice(BROKER_DIR.length + 1))

    expect(hits).toEqual([])
  })

  test('every export still resolves through an importer that only wants one of them', async () => {
    // `handlers/transcript.ts` is the importer that actually broke. Importing the
    // module under test directly would not reproduce it -- the failure was at the
    // IMPORTER's link step.
    const orchestrator = await import('./nightshift-orchestrator')
    expect(typeof orchestrator.noteCapacityUsageEvent).toBe('function')
    expect(typeof orchestrator.runNightshift).toBe('function')
    expect(typeof orchestrator.configureNightshiftRunner).toBe('function')
    expect(typeof orchestrator.resetNightshiftRunner).toBe('function')
    expect(typeof orchestrator.isNightshiftRunActive).toBe('function')
    expect(typeof orchestrator.advanceAllRuns).toBe('function')
    expect(typeof orchestrator.startNightshiftOrchestrator).toBe('function')
    expect(typeof orchestrator.configureCapacityAdmission).toBe('function')
    expect(typeof orchestrator.configureNightshiftIo).toBe('function')
    expect(typeof orchestrator.resetNightshiftIo).toBe('function')
  })
})
