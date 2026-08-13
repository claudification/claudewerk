import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookEvent } from '../shared/protocol'
import { computeCardNudge } from './card-nudge'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'card-nudge-'))
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function card(id: string, body: string): string {
  const abs = join(root, '.rclaude', 'project', 'cards', `${id}.md`)
  writeFileSync(abs, body, 'utf8')
  return abs
}

const event = (hookEvent: string, data?: unknown): HookEvent =>
  ({ type: 'hook', conversationId: 'c1', hookEvent, timestamp: 0, data }) as unknown as HookEvent

const write = (filePath: string, toolName = 'Write') => ({ tool_name: toolName, tool_input: { file_path: filePath } })

describe('computeCardNudge', () => {
  test('a bad card written by a tool call comes back as a block decision', () => {
    const abs = card('bad', '---\ntitle: B\nstatus: opne\n---\n\nbody\n')
    const decision = computeCardNudge(event('PostToolUse', write(abs)))
    expect(decision?.decision).toBe('block')
    expect(decision?.reason).toContain('card-status-invalid')
  })

  test('a good card is silent', () => {
    const abs = card('good', '---\ntitle: G\nstatus: open\n---\n\nbody\n')
    expect(computeCardNudge(event('PostToolUse', write(abs)))).toBeUndefined()
  })

  test('every other hook event is ignored -- this must not contend with the Stop nudge', () => {
    const abs = card('bad', '---\nstatus: opne\n---\n\nbody\n')
    for (const e of ['Stop', 'PreToolUse', 'SessionStart', 'SubagentStop']) {
      expect(computeCardNudge(event(e, write(abs)))).toBeUndefined()
    }
  })

  test('a tool call that wrote no card is ignored', () => {
    expect(computeCardNudge(event('PostToolUse', write(join(root, 'src/x.ts'))))).toBeUndefined()
    expect(computeCardNudge(event('PostToolUse', write(join(root, 'x.md'), 'Read')))).toBeUndefined()
  })

  test('missing or junk data never throws', () => {
    expect(computeCardNudge(event('PostToolUse'))).toBeUndefined()
    expect(computeCardNudge(event('PostToolUse', 'a string'))).toBeUndefined()
    expect(computeCardNudge(event('PostToolUse', { tool_name: 42 }))).toBeUndefined()
  })
})
