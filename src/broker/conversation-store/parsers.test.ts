import { describe, expect, test } from 'bun:test'
import { detectContextModeFromStdout } from './parsers'

/**
 * Regression suite for the context-mode parser.
 *
 * The bug this pins: the parser used to treat the ABSENCE of a `(1M context)`
 * label as proof of a 200K window. That was true when 1M was opt-in-only via
 * `[1m]`. For the default-1M families (Opus 4.7/4.8, Sonnet 5, Fable/Mythos 5)
 * CC prints no label at all, so `/model opus` persisted contextMode='standard'
 * and the control panel showed "130K / 200K" on a 1M session.
 *
 * Payloads below are verbatim samples pulled from real transcripts in store.db.
 */
describe('detectContextModeFromStdout -- /model confirmation', () => {
  test('default-1M family with no label is 1m (the reported bug)', () => {
    expect(detectContextModeFromStdout('Set model to opus (claude-opus-4-8)')).toBe('1m')
    expect(detectContextModeFromStdout('Set model to opus (claude-opus-4-7)')).toBe('1m')
    expect(detectContextModeFromStdout('Set model to fable (claude-fable-5)')).toBe('1m')
    expect(detectContextModeFromStdout('Set model to sonnet (claude-sonnet-5)')).toBe('1m')
  })

  test('explicit [1m] suffix with no "(1M context)" label is 1m', () => {
    expect(detectContextModeFromStdout('Set model to claude-sonnet-4-6[1m]')).toBe('1m')
  })

  test('explicit "(1M context)" label still wins', () => {
    expect(detectContextModeFromStdout('Set model to \x1b[1mOpus 4.6 (1M context)\x1b[22m for this session')).toBe('1m')
    expect(detectContextModeFromStdout('Kept model as claude-sonnet-4-6[1m] (1M context)')).toBe('1m')
  })

  test('opt-in-1M family without the suffix stays standard', () => {
    expect(detectContextModeFromStdout('Set model to sonnet (claude-sonnet-4-6)')).toBe('standard')
    expect(detectContextModeFromStdout('Set model to claude-opus-4-6')).toBe('standard')
  })

  test('models with no 1M support stay standard', () => {
    expect(detectContextModeFromStdout('Set model to haiku (claude-haiku-4-5-20251001)')).toBe('standard')
    expect(detectContextModeFromStdout('Set model to claude-haiku-4-5-20251001')).toBe('standard')
  })

  test('PTY display-name form resolves via the registry, both directions', () => {
    // ANSI bold (\x1b[1m) must NOT be mistaken for the [1m] variant suffix.
    expect(detectContextModeFromStdout('Set model to \x1b[1mSonnet 4.6\x1b[22m for this session')).toBe('standard')
    expect(detectContextModeFromStdout('Set model to \x1b[1mHaiku 4.5\x1b[22m')).toBe('standard')
    expect(detectContextModeFromStdout('Set model to \x1b[1mOpus 4.8\x1b[22m for this session')).toBe('1m')
  })

  test('unrecognized model leaves context mode untouched rather than guessing 200K', () => {
    expect(detectContextModeFromStdout('Set model to some-unreleased-model-9')).toBeUndefined()
  })
})

describe('detectContextModeFromStdout -- /context output', () => {
  const ctx = (tail: string) => `\x1b[1mContext Usage\x1b[22m \x1b[38;2;136;136;136m⛁ ⛁ ⛶ \x1b[39m  ${tail}`

  test('default-1M model id with no [1m] suffix is 1m', () => {
    expect(detectContextModeFromStdout(ctx('claude-opus-4-8 · 130k/1M tokens'))).toBe('1m')
  })

  test('"(1M context)" display-name form is 1m', () => {
    expect(detectContextModeFromStdout(ctx('Opus 4.7 (1M context)'))).toBe('1m')
  })

  test('[1m] suffix is 1m', () => {
    expect(detectContextModeFromStdout(ctx('claude-sonnet-4-6[1m] · 40k/1M tokens'))).toBe('1m')
  })

  test('opt-in family without the suffix stays standard', () => {
    expect(detectContextModeFromStdout(ctx('claude-sonnet-4-6 · 40k/200k tokens'))).toBe('standard')
  })
})

describe('detectContextModeFromStdout -- non-matching payloads', () => {
  test('returns undefined for unrelated stdout', () => {
    expect(detectContextModeFromStdout('Bash output: 42 files changed')).toBeUndefined()
    expect(detectContextModeFromStdout('')).toBeUndefined()
  })
})
