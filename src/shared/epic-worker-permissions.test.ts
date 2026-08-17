import { describe, expect, test } from 'bun:test'
import { buildEpicWorkerSettings, isMutedTool, MUTE_REASON, muteHookCommand } from './epic-worker-permissions'

describe('isMutedTool', () => {
  test.each([
    'AskUserQuestion',
    'mcp__rclaude__dialog',
    'mcp__rclaude__update_dialog',
    'mcp__rclaude__reopen_dialog',
    'mcp__rclaude__close_dialog',
    'mcp__rclaude__notify',
    'mcp__rclaude__send_message',
  ])('%s is a route to a human and is muted', tool => {
    expect(isMutedTool(tool)).toBe(true)
  })

  test.each([
    'Bash',
    'Read',
    'Edit',
    'Write',
    'mcp__rclaude__project_set_status',
    'mcp__rclaude__project_list',
    'mcp__rclaude__set_status',
  ])('%s is work, not escalation, and stays allowed', tool => {
    expect(isMutedTool(tool)).toBe(false)
  })

  test('the match is anchored -- a name merely containing a muted word is not blocked', () => {
    expect(isMutedTool('mcp__other__notify_team')).toBe(false)
    expect(isMutedTool('my_dialog')).toBe(false)
  })
})

describe('buildEpicWorkerSettings', () => {
  const preToolUse = (s: Record<string, unknown>) =>
    (s.hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse

  test('an implementer gets the deny-floor AND the mute', () => {
    const hooks = preToolUse(buildEpicWorkerSettings('implementer'))
    expect(hooks).toHaveLength(2)
    expect(hooks.some(h => h.hooks[0].command.includes('tool_name'))).toBe(true)
  })

  test('a verifier is muted too -- it judges, it does not escalate', () => {
    expect(preToolUse(buildEpicWorkerSettings('verifier'))).toHaveLength(2)
  })

  test('the overseer keeps its voice but still gets the deny-floor', () => {
    const hooks = preToolUse(buildEpicWorkerSettings('overseer'))
    expect(hooks).toHaveLength(1)
    expect(hooks[0].hooks[0].command).toContain('git +push')
  })

  test('per-project allow rules still merge through', () => {
    const s = buildEpicWorkerSettings('implementer', { allow: ['Bash(docker compose:*)'] })
    expect((s.permissions as { allow: string[] }).allow).toContain('Bash(docker compose:*)')
  })
})

describe('muteHookCommand', () => {
  test('emits a block verdict carrying the escape hatch, not a bare refusal', () => {
    const cmd = muteHookCommand()
    expect(cmd).toContain('.tool_name')
    // The verdict is JSON inside a shell double-quoted echo, so it is escaped twice.
    expect(cmd).toContain('decision')
    expect(cmd).toContain('block')
    expect(MUTE_REASON).toContain('needs-overseer')
    expect(MUTE_REASON).toContain('depends_on')
  })

  test('the reason carries no bare double quotes -- it round-trips through a shell echo', () => {
    expect(MUTE_REASON).not.toContain('"')
  })
})
