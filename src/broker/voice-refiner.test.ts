import { afterAll, beforeEach, expect, test } from 'bun:test'
import { initGlobalSettings } from './global-settings'
import type { KVStore } from './store/types'
import { contextBlockFrom, refinementSkipReason, refineTranscript, stripPreamble } from './voice-refiner'

/** Map-backed KVStore for driving initGlobalSettings without a real store. */
function fakeKv(settings: Record<string, unknown>): KVStore {
  const map = new Map<string, unknown>([['global-settings', settings]])
  return {
    get: <T = unknown>(key: string): T | null => (map.has(key) ? (map.get(key) as T) : null),
    set: <T = unknown>(key: string, value: T): void => {
      map.set(key, value)
    },
    delete: (key: string): boolean => map.delete(key),
    keys: (prefix?: string): string[] => [...map.keys()].filter(k => !prefix || k.startsWith(prefix)),
  }
}

const REAL_KEY = process.env.OPENROUTER_API_KEY

function withSettings(settings: Record<string, unknown>) {
  initGlobalSettings(fakeKv(settings))
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'sk-test-not-used'
})

afterAll(() => {
  if (REAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = REAL_KEY
  initGlobalSettings(fakeKv({}))
})

test('REGRESSION: an empty refinement prompt is a no-op, not a hardcoded default', () => {
  // It used to fall back to a built-in ASR-post-processor prompt, so "nothing
  // configured" still handed the transcript to an LLM to rewrite freehand.
  withSettings({ voiceRefinement: true, voiceRefinementPrompt: '' })
  expect(refinementSkipReason('hello world')).toBe('no refinement prompt configured')

  withSettings({ voiceRefinement: true, voiceRefinementPrompt: '   \n  ' })
  expect(refinementSkipReason('hello world')).toBe('no refinement prompt configured')
})

test('a skipped refinement returns the raw transcript verbatim, without calling out', async () => {
  withSettings({ voiceRefinement: true, voiceRefinementPrompt: '' })
  // No fetch mock: if this reached the network the test would hang or throw.
  expect(await refineTranscript('the raw words', ['keyterm'])).toBe('the raw words')
})

test('the other skip conditions still hold and are named', () => {
  withSettings({ voiceRefinement: false, voiceRefinementPrompt: 'clean it up' })
  expect(refinementSkipReason('hello')).toBe('disabled in settings')

  withSettings({ voiceRefinement: true, voiceRefinementPrompt: 'clean it up' })
  expect(refinementSkipReason('   ')).toBe('empty transcript')

  delete process.env.OPENROUTER_API_KEY
  expect(refinementSkipReason('hello')).toBe('no OPENROUTER_API_KEY')
})

test('a fully configured refiner is not skipped', () => {
  withSettings({ voiceRefinement: true, voiceRefinementPrompt: 'You clean transcripts.' })
  expect(refinementSkipReason('hello')).toBeNull()
})

test('contextBlockFrom degrades to empty on junk instead of throwing', () => {
  expect(contextBlockFrom('')).toBe('')
  expect(contextBlockFrom('not json at all')).toBe('')
  expect(contextBlockFrom('{}')).toBe('')
  const block = contextBlockFrom('```json\n{"domain":"DevOps","corrections":[{"heard":"flux","meant":"Flux"}]}\n```')
  expect(block).toContain('Domain: DevOps')
  expect(block).toContain('"flux" -> "Flux"')
})

test('stripPreamble removes assistant throat-clearing only', () => {
  expect(stripPreamble("Here's the corrected version: ship it")).toBe('ship it')
  expect(stripPreamble('Corrected: ship it')).toBe('ship it')
  expect(stripPreamble('ship it')).toBe('ship it')
  expect(stripPreamble('Sure, ship it')).toBe('ship it')
  // Must not eat real content that merely starts with a similar word (the old
  // pattern made punctuation optional and ate this "Sure").
  expect(stripPreamble('Sure enough the build passed')).toBe('Sure enough the build passed')
})
