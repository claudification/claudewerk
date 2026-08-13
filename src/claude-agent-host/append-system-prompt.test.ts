/**
 * The regression this file exists for: `claude` does NOT stack
 * `--append-system-prompt`. Pass it twice and only the LAST value survives --
 * verified live against claude 2.1.221, in all three orderings, with a
 * single-flag control proving the probe itself was sound.
 *
 * We used to pass it twice (spawn-injected text, then the agent host's harness
 * prompt), so every fork seed, nightshift preamble and SOTU brief was silently
 * discarded at launch with no error anywhere.
 */

import { describe, expect, it } from 'bun:test'
import { APPEND_SYSTEM_PROMPT_FLAG, composeAppendSystemPrompt } from './append-system-prompt'

/** Every value passed under the flag, in argv order. */
function appended(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === APPEND_SYSTEM_PROMPT_FLAG && args[i + 1] !== undefined) {
      out.push(args[i + 1])
      i++
    }
  }
  return out
}

describe('composeAppendSystemPrompt', () => {
  it('collapses a spawn-injected prompt and the harness prompt into ONE flag', () => {
    const args = ['--model', 'opus', APPEND_SYSTEM_PROMPT_FLAG, 'FORK SEED']
    composeAppendSystemPrompt(args, 'HARNESS PROMPT')

    // The whole bug in one assertion: two flags means CC drops one of them.
    expect(args.filter(a => a === APPEND_SYSTEM_PROMPT_FLAG)).toHaveLength(1)
    expect(appended(args)).toHaveLength(1)
    expect(appended(args)[0]).toContain('HARNESS PROMPT')
    expect(appended(args)[0]).toContain('FORK SEED')
  })

  it('keeps a fork provenance block intact alongside the harness prompt', () => {
    const seed = '<forked from_conversation="conv_parent">\nsummary text\n</forked>'
    const args = [APPEND_SYSTEM_PROMPT_FLAG, seed]
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(appended(args)[0]).toContain('<forked from_conversation="conv_parent">')
    expect(appended(args)[0]).toContain('</forked>')
  })

  it('leads with the harness prompt and keeps injected text after it', () => {
    const args = [APPEND_SYSTEM_PROMPT_FLAG, 'INJECTED']
    composeAppendSystemPrompt(args, 'HARNESS')

    const value = appended(args)[0]
    expect(value.indexOf('HARNESS')).toBeLessThan(value.indexOf('INJECTED'))
  })

  it('merges several pre-existing flags in argv order', () => {
    const args = [APPEND_SYSTEM_PROMPT_FLAG, 'FIRST', '--model', 'opus', APPEND_SYSTEM_PROMPT_FLAG, 'SECOND']
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(appended(args)).toHaveLength(1)
    expect(appended(args)[0]).toBe('HARNESS\n\nFIRST\n\nSECOND')
  })

  it('preserves every unrelated argument, in order', () => {
    const args = ['--model', 'opus', APPEND_SYSTEM_PROMPT_FLAG, 'SEED', '--effort', 'high']
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(args.slice(0, 4)).toEqual(['--model', 'opus', '--effort', 'high'])
  })

  it('mutates in place so callers holding the array by reference see the merge', () => {
    // brokerDeps.claudeArgs captures this array BEFORE composition runs; that
    // snapshot is what gets persisted and rendered in the control panel.
    const args = [APPEND_SYSTEM_PROMPT_FLAG, 'SEED']
    const captured = args
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(captured).toBe(args)
    expect(appended(captured)[0]).toContain('HARNESS')
    expect(appended(captured)[0]).toContain('SEED')
  })

  it('emits a single flag when only the harness prompt exists', () => {
    const args = ['--model', 'opus']
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(appended(args)).toEqual(['HARNESS'])
  })

  it('emits no flag at all when there is nothing to append', () => {
    const args = ['--model', 'opus']
    composeAppendSystemPrompt(args, undefined, '', '   ')

    expect(args).toEqual(['--model', 'opus'])
  })

  it('drops empty parts rather than opening the value with blank lines', () => {
    const args = [APPEND_SYSTEM_PROMPT_FLAG, '  SEED  ']
    composeAppendSystemPrompt(args, '', 'HARNESS', undefined)

    expect(appended(args)).toEqual(['HARNESS\n\nSEED'])
  })

  it('round-trips a value that is itself the flag string', () => {
    // Pathological, but a forward scan must not mistake the VALUE for a flag
    // and silently eat the pair.
    const args = [APPEND_SYSTEM_PROMPT_FLAG, APPEND_SYSTEM_PROMPT_FLAG]
    composeAppendSystemPrompt(args)

    expect(appended(args)).toEqual([APPEND_SYSTEM_PROMPT_FLAG])
  })

  it('tolerates a trailing flag with no value', () => {
    const args = ['--model', 'opus', APPEND_SYSTEM_PROMPT_FLAG]
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(args).toEqual(['--model', 'opus', APPEND_SYSTEM_PROMPT_FLAG, 'HARNESS'])
  })

  it('re-composing with no new leading parts is a no-op, not a nesting', () => {
    // The contract is call-ONCE-per-launch. This only pins that a bare re-scan
    // does not wrap or duplicate the already-merged value; it does NOT claim
    // general idempotence (see the next test).
    const args = [APPEND_SYSTEM_PROMPT_FLAG, 'SEED']
    composeAppendSystemPrompt(args, 'HARNESS')
    const once = appended(args)[0]
    composeAppendSystemPrompt(args)

    expect(appended(args)).toEqual([once])
  })

  it('is NOT idempotent when the same leading part is passed again', () => {
    // Documented honestly so nobody adds a second call site expecting a merge.
    const args = [APPEND_SYSTEM_PROMPT_FLAG, 'SEED']
    composeAppendSystemPrompt(args, 'HARNESS')
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(appended(args)).toEqual(['HARNESS\n\nHARNESS\n\nSEED'])
  })

  it('absorbs the --flag=VALUE form instead of leaving it as a second flag', () => {
    // The bug in miniature: an unabsorbed `=` form stays in argv, the composed
    // flag lands after it, and CC keeps only the last -- dropping the user text.
    const args = [`${APPEND_SYSTEM_PROMPT_FLAG}=USER TEXT`, '--model', 'opus']
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(args.some(a => a.startsWith(`${APPEND_SYSTEM_PROMPT_FLAG}=`))).toBe(false)
    expect(appended(args)).toEqual(['HARNESS\n\nUSER TEXT'])
    expect(args.filter(a => a === APPEND_SYSTEM_PROMPT_FLAG)).toHaveLength(1)
  })

  it('keeps an --flag=VALUE whose value is empty from emitting a stray flag', () => {
    const args = [`${APPEND_SYSTEM_PROMPT_FLAG}=`]
    composeAppendSystemPrompt(args)

    expect(args).toEqual([])
  })

  it('merges the --flag=VALUE form together with the spaced form, in order', () => {
    const args = [`${APPEND_SYSTEM_PROMPT_FLAG}=FIRST`, APPEND_SYSTEM_PROMPT_FLAG, 'SECOND']
    composeAppendSystemPrompt(args, 'HARNESS')

    expect(appended(args)).toEqual(['HARNESS\n\nFIRST\n\nSECOND'])
  })

  it('drops a dangling flag rather than letting it swallow the composed value', () => {
    // Nothing to append at all: the malformed token must not survive, or CC
    // would consume whatever follows it as its argument.
    const args = ['--model', 'opus', APPEND_SYSTEM_PROMPT_FLAG]
    composeAppendSystemPrompt(args)

    expect(args).toEqual(['--model', 'opus'])
  })
})
