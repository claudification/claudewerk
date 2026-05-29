/**
 * Regression fixtures captured from REAL recap runs (the on-disk run-artifact
 * bundles, Pillar C+, pulled from the broker's /data/cache/recaps/<id>/
 * final-response.txt). The synthetic unit tests in parse-recap.test.ts missed
 * the v2.1 "cards render as raw {json}" bug because they hand-wrote block-style
 * YAML, while the reduce/oneshot LLM actually emits inline flow-maps. These
 * fixtures are the genuine model output, so they lock the real contract.
 *
 * If a future prompt/model change alters the emitted shape, these break first.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRecapOutput } from './parse-recap'

const FIXTURES = [
  { file: 'real-recap-human-retrospect.txt', audience: 'human', retrospect: true },
  { file: 'real-recap-agent-haiku-map.txt', audience: 'agent', retrospect: false },
  { file: 'real-recap-agent-sonnet-map.txt', audience: 'agent', retrospect: false },
] as const

function load(file: string): string {
  return readFileSync(join(import.meta.dir, '__fixtures__', file), 'utf8')
}

describe('parseRecapOutput on real recap artifacts (regression)', () => {
  for (const fx of FIXTURES) {
    describe(fx.file, () => {
      const { metadata } = parseRecapOutput(load(fx.file))

      it('extracts multiple features with CLEAN titles (not raw {json} blobs)', () => {
        expect(metadata.features.length).toBeGreaterThan(3)
        for (const f of metadata.features) {
          // The bug: the whole "{title: ..., detail: ...}" flow-map became the
          // title. Assert the flow-map wrapper is gone -- NOT that '{' never
          // appears (a legit title can contain e.g. "usage:{include:true}").
          expect(f.title.startsWith('{')).toBe(false)
          expect(f.title).not.toMatch(/^\{?\s*"?title"?\s*:/i)
          expect(f.title).not.toContain(', detail:')
          expect(f.title.length).toBeGreaterThan(0)
          expect(f.title.length).toBeLessThan(160)
        }
      })

      it('extracts citations (conversations/commits) from flow-map items', () => {
        const withCitations = metadata.features.filter(
          f => (f.conversations?.length ?? 0) > 0 || (f.commits?.length ?? 0) > 0,
        )
        expect(withCitations.length).toBeGreaterThan(2)
        // Citation tokens must be bare ids, never leftover YAML/brace fragments.
        for (const f of metadata.features) {
          for (const c of f.conversations ?? []) expect(c).not.toMatch(/[{}[\]"]/)
          for (const c of f.commits ?? []) expect(c).not.toMatch(/[{}[\]"]/)
        }
      })

      it('extracts the simple string lists (keywords/goals)', () => {
        expect(metadata.keywords.length).toBeGreaterThan(2)
        expect(metadata.goals.length).toBeGreaterThan(0)
        expect(metadata.subtitle?.length ?? 0).toBeGreaterThan(0)
      })

      if (fx.retrospect) {
        it('extracts Pillar F retrospect items with clean titles', () => {
          const retro = [
            ...(metadata.went_well ?? []),
            ...(metadata.went_badly ?? []),
            ...(metadata.recommendations ?? []),
          ]
          expect(retro.length).toBeGreaterThan(0)
          for (const r of retro) expect(r.title).not.toContain('{')
        })
      }
    })
  }
})
