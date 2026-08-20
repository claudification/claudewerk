/**
 * THE ACKNOWLEDGEMENT SURVIVES EVERYTHING THE PANE DOES NOT.
 *
 * `clear` is only worth anything if the run stays cleared -- a dismissal held in
 * a browser would come back on the next poll, in the next tab, and after every
 * broker restart, which is worse than no button at all. So the stamp goes on the
 * artifact, and this is the round trip that proves it: write it, throw the
 * in-memory copy away, read it off disk again.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { epicRunFile } from './epic-paths'
import { patchEpicRun, readEpicRun, startEpicRun } from './epic-run-store'

const T0 = Date.parse('2026-08-21T09:00:00.000Z')

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'epic-run-ack-'))
}

function withRoot(fn: (root: string) => void): void {
  const root = freshRoot()
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the run acknowledgement on disk', () => {
  test('a fresh run carries none', () => {
    withRoot(root => {
      startEpicRun(root, { epicId: 'e1', project: 'claude:///p' }, T0)
      expect(readEpicRun(root, 'e1')?.acknowledgedAt).toBeUndefined()
    })
  })

  test('it is written to the artifact and reads back from a FRESH read', () => {
    withRoot(root => {
      startEpicRun(root, { epicId: 'e1', project: 'claude:///p' }, T0)
      patchEpicRun(root, 'e1', { status: 'aborted' }, T0)
      patchEpicRun(root, 'e1', { acknowledgedAt: new Date(T0).toISOString() }, T0)

      // A fresh read is what a restarted broker, a second browser and the next
      // poll all do. No caching anywhere in this path, by design.
      expect(readEpicRun(root, 'e1')?.acknowledgedAt).toBe(new Date(T0).toISOString())
      expect(readFileSync(epicRunFile(root, 'e1'), 'utf8')).toContain('acknowledgedAt:')
    })
  })

  test('it does not disturb the rest of the run', () => {
    withRoot(root => {
      startEpicRun(root, { epicId: 'e1', project: 'claude:///p', maxGens: 12 }, T0)
      patchEpicRun(root, 'e1', { status: 'paused', gen: 7 }, T0)
      patchEpicRun(root, 'e1', { acknowledgedAt: new Date(T0).toISOString() }, T0)

      const run = readEpicRun(root, 'e1')
      expect(run?.status).toBe('paused')
      expect(run?.gen).toBe(7)
      expect(run?.maxGens).toBe(12)
    })
  })

  /** A RUN THAT STARTED AGAIN IS NEWS AGAIN. Without this a re-armed run would
   *  stay off the wall while it was genuinely running. */
  test('re-arming wipes it, and the wipe is on disk too', () => {
    withRoot(root => {
      startEpicRun(root, { epicId: 'e1', project: 'claude:///p' }, T0)
      patchEpicRun(root, 'e1', { status: 'paused' }, T0)
      patchEpicRun(root, 'e1', { acknowledgedAt: new Date(T0).toISOString() }, T0)

      startEpicRun(root, { epicId: 'e1', project: 'claude:///p' }, T0 + 1000)

      expect(readEpicRun(root, 'e1')?.acknowledgedAt).toBeUndefined()
      expect(readFileSync(epicRunFile(root, 'e1'), 'utf8')).not.toContain('acknowledgedAt:')
    })
  })
})
