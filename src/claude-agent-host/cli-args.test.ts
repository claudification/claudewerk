/**
 * Tests for the transport-reframe Phase 2 config-injection plumbing in cli-args:
 *  - buildMcpConfigArgs: append a spawn-injected --mcp-config value (CC merges).
 *  - parseCliArgs: append-system-prompt via inline env (headless) or file (PTY).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMcpConfigArgs, parseCliArgs } from './cli-args'

describe('buildMcpConfigArgs', () => {
  it('passes only the rclaude HTTP MCP config when no injected path', () => {
    expect(buildMcpConfigArgs('/x/mcp-rclaude.json')).toEqual(['--mcp-config', '/x/mcp-rclaude.json'])
  })

  it('appends the spawn-injected config as an extra --mcp-config value (variadic merge)', () => {
    expect(buildMcpConfigArgs('/x/mcp-rclaude.json', '/u/custom-mcp.json')).toEqual([
      '--mcp-config',
      '/x/mcp-rclaude.json',
      '/u/custom-mcp.json',
    ])
  })
})

describe('parseCliArgs -- thinking-display injection', () => {
  const prev = process.env.CLAUDWERK_THINKING_DISPLAY

  beforeEach(() => {
    delete process.env.CLAUDWERK_THINKING_DISPLAY
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDWERK_THINKING_DISPLAY
    else process.env.CLAUDWERK_THINKING_DISPLAY = prev
  })

  /** Value following --thinking-display, or undefined when the flag is absent. */
  const displayValue = (args: string[]): string | undefined => {
    const i = args.indexOf('--thinking-display')
    return i >= 0 ? args[i + 1] : undefined
  }

  it('opts in by default when the env is unset (CC redacts thinking otherwise)', async () => {
    const cfg = await parseCliArgs([])
    expect(displayValue(cfg.claudeArgs)).toBe('summarized')
  })

  it('opts in when the sentinel resolved summaries ON', async () => {
    process.env.CLAUDWERK_THINKING_DISPLAY = 'summarized'
    const cfg = await parseCliArgs([])
    expect(displayValue(cfg.claudeArgs)).toBe('summarized')
  })

  it('emits NO flag when summaries are off -- omitted is already CC behavior', async () => {
    process.env.CLAUDWERK_THINKING_DISPLAY = 'omitted'
    const cfg = await parseCliArgs([])
    expect(cfg.claudeArgs).not.toContain('--thinking-display')
  })

  it('falls back to the ON default when the env value is junk', async () => {
    process.env.CLAUDWERK_THINKING_DISPLAY = 'yes-please'
    const cfg = await parseCliArgs([])
    expect(displayValue(cfg.claudeArgs)).toBe('summarized')
  })

  it('never double-injects over a user-supplied --thinking-display', async () => {
    const cfg = await parseCliArgs(['--thinking-display', 'omitted'])
    expect(cfg.claudeArgs.filter(a => a === '--thinking-display')).toHaveLength(1)
    expect(displayValue(cfg.claudeArgs)).toBe('omitted')
  })
})

describe('parseCliArgs -- append-system-prompt injection', () => {
  let dir: string
  const prevInline = process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT
  const prevFile = process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-args-test-'))
    delete process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT
    delete process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE
  })

  afterEach(() => {
    restore('CLAUDWERK_APPEND_SYSTEM_PROMPT', prevInline)
    restore('CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE', prevFile)
    rmSync(dir, { recursive: true, force: true })
  })

  const restore = (key: string, prev: string | undefined): void => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }

  /** Pull the value that follows the first --append-system-prompt flag. */
  const appendedValue = (args: string[]): string | undefined => {
    const i = args.indexOf('--append-system-prompt')
    return i >= 0 ? args[i + 1] : undefined
  }

  it('uses the inline env var (headless path)', async () => {
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT = 'INLINE PROMPT'
    const cfg = await parseCliArgs([])
    expect(appendedValue(cfg.claudeArgs)).toBe('INLINE PROMPT')
  })

  it('reads the file when only the file env var is set (PTY path)', async () => {
    const file = join(dir, 'append.txt')
    writeFileSync(file, "FILE PROMPT with 'quotes' and\nnewlines $VARS")
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE = file
    const cfg = await parseCliArgs([])
    expect(appendedValue(cfg.claudeArgs)).toBe("FILE PROMPT with 'quotes' and\nnewlines $VARS")
  })

  it('prefers the inline env var over the file when both are set', async () => {
    const file = join(dir, 'append.txt')
    writeFileSync(file, 'FROM FILE')
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT = 'FROM INLINE'
    process.env.CLAUDWERK_APPEND_SYSTEM_PROMPT_FILE = file
    const cfg = await parseCliArgs([])
    expect(appendedValue(cfg.claudeArgs)).toBe('FROM INLINE')
  })

  it('appends nothing when neither env var is set', async () => {
    const cfg = await parseCliArgs([])
    expect(cfg.claudeArgs).not.toContain('--append-system-prompt')
  })
})
