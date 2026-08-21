import { afterAll, beforeEach, expect, test } from 'bun:test'
import { initGlobalSettings } from '../global-settings'
import type { KVStore } from '../store/types'
import { resolveRequest, screenRefineRequest } from './voice-refine'

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

/** Refinement fully on, so a skip in these tests can only come from the screen. */
function refinerConfigured() {
  initGlobalSettings(fakeKv({ voiceRefinement: true, voiceRefinementPrompt: 'clean it up' }))
}

const ALLOWED = { isShareGuest: false, hasVoicePermission: true, project: 'claude://host/repo' }

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'sk-test-not-used'
  refinerConfigured()
})

afterAll(() => {
  if (REAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = REAL_KEY
  initGlobalSettings(fakeKv({}))
})

test('a fully allowed request with a real transcript is not screened out', () => {
  expect(screenRefineRequest(ALLOWED, 'the sentinel dropped its worktree')).toBeNull()
})

test('a share guest is refused refinement, but still gets a 200 path', () => {
  // Not 'forbidden': a guest dictating should still have their words delivered,
  // just unrefined. Only the operator's OpenRouter spend is being protected.
  const verdict = screenRefineRequest({ ...ALLOWED, isShareGuest: true }, 'hello')
  expect(verdict).toBe('share guest')
  expect(verdict).not.toBe('forbidden')
})

test('a user without voice permission on that project is forbidden outright', () => {
  expect(screenRefineRequest({ ...ALLOWED, hasVoicePermission: false }, 'hello')).toBe('forbidden')
})

test('no resolvable project means no project-scoped permission to check', () => {
  // An ad-hoc dictation with no conversation attached must not 403 on a
  // permission that has nothing to be scoped against.
  // The transcript has to clear the trivial-transcript floor or the screen skips
  // on LENGTH and this stops testing the permission path at all.
  expect(
    screenRefineRequest(
      { isShareGuest: false, hasVoicePermission: false, project: null },
      'the sentinel dropped its worktree',
    ),
  ).toBeNull()
})

test('the screen still defers to refinementSkipReason for configuration', () => {
  expect(screenRefineRequest(ALLOWED, '   ')).toBe('empty transcript')

  initGlobalSettings(fakeKv({ voiceRefinement: true, voiceRefinementPrompt: '' }))
  expect(screenRefineRequest(ALLOWED, 'hello')).toBe('no refinement prompt configured')

  initGlobalSettings(fakeKv({ voiceRefinement: false, voiceRefinementPrompt: 'clean it up' }))
  expect(screenRefineRequest(ALLOWED, 'hello')).toBe('disabled in settings')
})

test('the share-guest refusal is checked BEFORE settings, so it cannot be masked', () => {
  // If the order flipped, a broker with refinement switched off would report
  // 'disabled in settings' to a guest and the guest check would never be
  // exercised -- the bug would only appear the day refinement was turned on.
  initGlobalSettings(fakeKv({ voiceRefinement: false, voiceRefinementPrompt: '' }))
  expect(screenRefineRequest({ ...ALLOWED, isShareGuest: true }, 'hello')).toBe('share guest')
})

// ─── Request resolution ─────────────────────────────────────────────

/** Only the one method resolveRequest touches. */
function storeWith(project: string | null) {
  return { getConversation: () => (project ? { project } : null) } as never
}

test('an explicit project in the body wins over the conversation lookup', () => {
  const req = resolveRequest(
    { text: 'hi', conversationId: 'conv_1', project: 'claude://a/b' },
    storeWith('claude://x/y'),
  )
  expect(req.project).toBe('claude://a/b')
})

test('the project falls back to the conversation, then to null', () => {
  expect(resolveRequest({ text: 'hi', conversationId: 'conv_1' }, storeWith('claude://x/y')).project).toBe(
    'claude://x/y',
  )
  expect(resolveRequest({ text: 'hi', conversationId: 'conv_1' }, storeWith(null)).project).toBeNull()
  expect(resolveRequest({ text: 'hi' }, storeWith('claude://x/y')).project).toBeNull()
})

test('an oversized transcript is truncated, not rejected', () => {
  // The user still gets their words; only the refiner's input is bounded.
  const req = resolveRequest({ text: 'a'.repeat(50_000) }, storeWith(null))
  expect(req.text.length).toBe(20000)
})

test('a body missing every field resolves to safe empties', () => {
  const req = resolveRequest({}, storeWith(null))
  expect(req).toEqual({ text: '', conversationId: null, project: null })
})
