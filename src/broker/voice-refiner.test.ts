import { afterAll, beforeEach, expect, test } from 'bun:test'
import {
  DEFAULT_VOICE_REFINER_MODEL,
  resolveVoiceRefinerModel,
  VOICE_REFINER_MODELS,
} from '../shared/voice-refiner-models'
import { initGlobalSettings } from './global-settings'
import type { KVStore } from './store/types'
import {
  contextBlockFrom,
  RECOMMENDED_VOICE_PROMPT,
  refinementSkipReason,
  refineTranscript,
  stripPreamble,
} from './voice-refiner'

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

// ─── Model selection ────────────────────────────────────────────────

test('an unknown or missing refiner model degrades to the default, never a 400', () => {
  expect(resolveVoiceRefinerModel(undefined)).toBe(DEFAULT_VOICE_REFINER_MODEL)
  expect(resolveVoiceRefinerModel(null)).toBe(DEFAULT_VOICE_REFINER_MODEL)
  expect(resolveVoiceRefinerModel('')).toBe(DEFAULT_VOICE_REFINER_MODEL)
  // A model id someone typed by hand, or one removed from the list since the
  // setting was saved. Falling through to OpenRouter would 400 away a dictation.
  expect(resolveVoiceRefinerModel('acme/not-a-real-model')).toBe(DEFAULT_VOICE_REFINER_MODEL)
  expect(resolveVoiceRefinerModel('openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b')
})

test('the default refiner model is one the list actually offers', () => {
  expect(VOICE_REFINER_MODELS[DEFAULT_VOICE_REFINER_MODEL]).toBeDefined()
})

// ─── The deadline ───────────────────────────────────────────────────

test('REGRESSION: a refiner slower than the deadline returns the RAW transcript', async () => {
  // There was no timeout at all before 2026-08-18: a slow model held the user's
  // words hostage for as long as it liked, with the recorder stuck on 'refining'.
  withSettings({
    voiceRefinement: true,
    voiceRefinementPrompt: 'clean it up',
    voiceRefinementDeadlineMs: 50,
    voiceRefinementContextPass: false,
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch // never resolves
  try {
    const started = Date.now()
    expect(await refineTranscript('the raw words', [])).toBe('the raw words')
    // Returned on the deadline, not on the (never-arriving) response.
    expect(Date.now() - started).toBeLessThan(1000)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('deadline 0 means no deadline -- the refiner is awaited however long it takes', async () => {
  withSettings({
    voiceRefinement: true,
    voiceRefinementPrompt: 'clean it up',
    voiceRefinementDeadlineMs: 0,
    voiceRefinementContextPass: false,
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    await new Promise(r => setTimeout(r, 60))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'the clean words' } }] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  try {
    expect(await refineTranscript('the raw words', [])).toBe('the clean words')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a refiner that throws falls back to raw rather than losing the dictation', async () => {
  withSettings({
    voiceRefinement: true,
    voiceRefinementPrompt: 'clean it up',
    voiceRefinementDeadlineMs: 2000,
    voiceRefinementContextPass: false,
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('openrouter is down'))) as unknown as typeof fetch
  try {
    expect(await refineTranscript('the raw words', [])).toBe('the raw words')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ─── The recommended prompt ─────────────────────────────────────────

test('the recommended prompt is offered but is NOT the schema default', () => {
  // Shipping it as the default would silently re-enable freehand rewriting for
  // everyone -- the exact regression the empty-prompt rule exists to prevent.
  withSettings({})
  expect(refinementSkipReason('hello')).toBe('no refinement prompt configured')
  expect(RECOMMENDED_VOICE_PROMPT).toContain('NO NONSENSE WORDS SURVIVE')
  expect(RECOMMENDED_VOICE_PROMPT.length).toBeLessThanOrEqual(4000)
})
