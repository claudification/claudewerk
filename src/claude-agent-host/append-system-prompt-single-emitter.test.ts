/**
 * The single-emitter invariant, asserted BEHAVIOURALLY.
 *
 * `claude` keeps only the LAST `--append-system-prompt` and silently drops the
 * rest. The regression this guards is the real one that shipped: `cli-args`
 * pushed the spawn-injected text (fork seed, nightshift preamble, SOTU brief)
 * and `index` pushed the harness prompt, so the harness prompt ate the lot and a
 * summarized fork booted with none of its inherited context.
 *
 * This drives the ACTUAL pipeline -- `parseCliArgs` with the real env vars set,
 * then the composition `index.ts` performs -- and asserts the launch argv ends
 * up with exactly one occurrence carrying BOTH halves. A grep for the flag
 * literal cannot do that: a second `push(APPEND_SYSTEM_PROMPT_FLAG, ...)` via
 * the exported constant would sail straight past it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPEND_SYSTEM_PROMPT_FLAG, composeAppendSystemPrompt } from './append-system-prompt'
import { parseCliArgs } from './cli-args'

const HARNESS = '# MCP Tools (rclaude)\nharness prompt body'
const FORK_SEED = '<forked from_conversation="conv_parent">\ninherited context\n</forked>'

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

/** What `index.ts` does after writing the harness prompt file. */
async function launchArgs(argv: string[] = []): Promise<string[]> {
  const cfg = await parseCliArgs(argv)
  composeAppendSystemPrompt(cfg.claudeArgs, HARNESS)
  return cfg.claudeArgs
}

describe('append-system-prompt single-emitter invariant (end to end)', () => {
  let dir: string
  const prevInline = process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT
  const prevFile = process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE

  const restore = (key: string, prev: string | undefined): void => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'append-sp-emitter-'))
    delete process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT
    delete process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE
  })

  afterEach(() => {
    restore('CLAUDWERK_APPEND_SYSTEM_PROMPT', prevInline)
    restore('CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE', prevFile)
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits ONE flag carrying both the harness prompt and the inline fork seed', async () => {
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT = FORK_SEED

    const args = await launchArgs()

    expect(args.filter(a => a === APPEND_SYSTEM_PROMPT_FLAG)).toHaveLength(1)
    expect(appended(args)).toHaveLength(1)
    expect(appended(args)[0]).toContain(HARNESS)
    expect(appended(args)[0]).toContain('<forked from_conversation="conv_parent">')
  })

  it('emits ONE flag when the seed arrives via the PTY file path', async () => {
    const file = join(dir, 'append.txt')
    writeFileSync(file, FORK_SEED)
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE = file

    const args = await launchArgs()

    expect(appended(args)).toHaveLength(1)
    expect(appended(args)[0]).toContain(HARNESS)
    expect(appended(args)[0]).toContain('inherited context')
  })

  it('keeps a user-supplied flag AND the spawn-injected seed', async () => {
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT = FORK_SEED

    const args = await launchArgs([APPEND_SYSTEM_PROMPT_FLAG, 'USER TEXT'])

    expect(appended(args)).toHaveLength(1)
    expect(appended(args)[0]).toContain(HARNESS)
    expect(appended(args)[0]).toContain('USER TEXT')
    expect(appended(args)[0]).toContain('inherited context')
  })

  it('keeps a user-supplied flag written in the --flag=VALUE form', async () => {
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT = FORK_SEED

    const args = await launchArgs([`${APPEND_SYSTEM_PROMPT_FLAG}=USER EQUALS TEXT`])

    expect(appended(args)).toHaveLength(1)
    expect(args.some(a => a.startsWith(`${APPEND_SYSTEM_PROMPT_FLAG}=`))).toBe(false)
    expect(appended(args)[0]).toContain('USER EQUALS TEXT')
    expect(appended(args)[0]).toContain('inherited context')
  })

  it('still emits the harness prompt when nothing was injected', async () => {
    const args = await launchArgs()

    expect(appended(args)).toEqual([HARNESS])
  })
})
