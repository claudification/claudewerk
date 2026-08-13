/**
 * The probe's only job is to make a leaked cache generation impossible to miss
 * in the boot log, so the wording of that line is the thing worth testing.
 */

import { describe, expect, test } from 'vitest'
import { type CacheGeneration, formatCacheReport } from './cache-storage-probe'

function gen(name: string, entries: number, current = false): CacheGeneration {
  return { name, entries, current }
}

describe('formatCacheReport', () => {
  test('calls out stale generations and how many there are', () => {
    const line = formatCacheReport([
      gen('rclaude-precache-aaa', 406),
      gen('rclaude-precache-bbb', 406),
      gen('rclaude-precache-ccc', 406, true),
    ])

    expect(line).toContain('2 STALE precache generation(s)')
    expect(line).toContain('1218 entries')
  })

  test('stays quiet when only the current generation is present', () => {
    const line = formatCacheReport([gen('rclaude-precache-aaa', 406, true)])

    expect(line).not.toContain('STALE')
    expect(line).toContain('rclaude-precache-aaa=406*')
  })

  test('counts non-precache buckets without calling them stale', () => {
    const line = formatCacheReport([gen('rclaude-precache-aaa', 10, true), gen('rclaude-files-v1', 50)])

    expect(line).not.toContain('STALE')
    expect(line).toContain('rclaude-files-v1=50')
  })
})
