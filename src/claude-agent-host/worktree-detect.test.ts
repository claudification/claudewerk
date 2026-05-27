import { describe, expect, test } from 'bun:test'
import type { HookEvent, TranscriptEntry } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { detectWorktreeCwd } from './worktree-detect'

const REPO = '/Users/jonas/projects/portal2'
const WT = `${REPO}/.claude/worktrees/markdown-everywhere`

function buildCtx(): { ctx: AgentHostContext; sent: HookEvent[] } {
  const sent: HookEvent[] = []
  const ctx = {
    conversationId: 'conv_test12345',
    cwd: REPO,
    claudeSessionId: 'sess_abc',
    lastWorktreeCwd: undefined,
    wsClient: { sendHookEvent: (e: HookEvent) => sent.push(e) },
    debug: () => {},
  } as unknown as AgentHostContext
  return { ctx, sent }
}

/** A `user` entry carrying a translated tool_result block (post-dialect:
 *  block.raw.name = source tool, block.raw.toolUseResult = sidecar). */
function toolResultEntry(name: string, toolUseResult: unknown, isError = false): TranscriptEntry {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          is_error: isError,
          raw: { backend: 'claude', name, toolUseResult },
        },
      ],
    },
  } as unknown as TranscriptEntry
}

describe('detectWorktreeCwd', () => {
  test('EnterWorktree -> CwdChanged with the resolved worktreePath', () => {
    const { ctx, sent } = buildCtx()
    const out = detectWorktreeCwd(ctx, [
      toolResultEntry('EnterWorktree', { worktreePath: WT, message: 'Created worktree at ...' }),
    ])
    expect(out).toBe(WT)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'hook',
      conversationId: 'conv_test12345',
      hookEvent: 'CwdChanged',
      data: { cwd: WT, session_id: 'sess_abc' },
    })
    expect(ctx.lastWorktreeCwd).toBe(WT)
  })

  test('ExitWorktree -> CwdChanged back to the boot cwd (repo root)', () => {
    const { ctx, sent } = buildCtx()
    ctx.lastWorktreeCwd = WT // we were in a worktree
    const out = detectWorktreeCwd(ctx, [toolResultEntry('ExitWorktree', { message: 'Exited worktree.' })])
    expect(out).toBe(REPO)
    expect(sent[0].data).toMatchObject({ cwd: REPO })
  })

  test('dedup: same worktree path twice emits once', () => {
    const { ctx, sent } = buildCtx()
    const entries = [toolResultEntry('EnterWorktree', { worktreePath: WT })]
    detectWorktreeCwd(ctx, entries)
    const second = detectWorktreeCwd(ctx, [toolResultEntry('EnterWorktree', { worktreePath: WT })])
    expect(second).toBeUndefined()
    expect(sent).toHaveLength(1)
  })

  test('errored worktree result is ignored', () => {
    const { ctx, sent } = buildCtx()
    const out = detectWorktreeCwd(ctx, [toolResultEntry('EnterWorktree', { worktreePath: WT }, true)])
    expect(out).toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  test('non-worktree tool results are ignored', () => {
    const { ctx, sent } = buildCtx()
    const out = detectWorktreeCwd(ctx, [toolResultEntry('Bash', { stdout: 'hi' })])
    expect(out).toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  test('falls back to parsing the path out of the result message', () => {
    const { ctx, sent } = buildCtx()
    const out = detectWorktreeCwd(ctx, [
      toolResultEntry('EnterWorktree', { message: `Created worktree at ${WT}. The session is now working there.` }),
    ])
    expect(out).toBe(WT)
    expect(sent).toHaveLength(1)
  })

  test('last move in the batch wins', () => {
    const { ctx, sent } = buildCtx()
    const out = detectWorktreeCwd(ctx, [
      toolResultEntry('EnterWorktree', { worktreePath: WT }),
      toolResultEntry('ExitWorktree', {}),
    ])
    expect(out).toBe(REPO)
    expect(sent).toHaveLength(1)
    expect(sent[0].data).toMatchObject({ cwd: REPO })
  })
})
