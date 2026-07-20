/**
 * Replay of a REAL CC hook capture through the attribution seam.
 *
 * The fixture is the verbatim hook stream from a live `claude -p` run on CC
 * 2.1.209 (see __fixtures__/cc-2.1.209-background-subagent.jsonl): the parent
 * launches a BACKGROUND subagent and then runs three Bash commands of its own
 * while that subagent sleeps. This is the shape that broke the old
 * running-window heuristic -- it tagged all six parent hooks with the
 * subagent's id, and the broker then contained them off the parent
 * conversation (add-event.ts skips the status flip AND the whole handler
 * dispatch for subagent-originated events).
 *
 * Hand-written fixtures could not have caught this: the bug lived in an
 * assumption about CC's behavior, not in our logic. Hence a real capture.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEvent, HookEventType } from '../shared/protocol'
import { resolveSubagentAttribution } from './hook-forward'

interface CapturedHook {
  hook_event_name: HookEventType
  agent_id: string | null
  tool_name: string | null
  cmd: string | null
}

const CAPTURE: CapturedHook[] = readFileSync(
  join(import.meta.dir, '__fixtures__', 'cc-2.1.209-background-subagent.jsonl'),
  'utf8',
)
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as CapturedHook)

/** Rebuild the HookEvent the agent host would forward for a captured hook. */
function toHookEvent(c: CapturedHook): HookEvent {
  return {
    type: 'hook',
    conversationId: 'conv_parent',
    hookEvent: c.hook_event_name,
    timestamp: 1,
    data: {
      session_id: 'parent_session',
      ...(c.agent_id ? { agent_id: c.agent_id } : {}),
      ...(c.tool_name ? { tool_name: c.tool_name } : {}),
      ...(c.cmd ? { tool_input: { command: c.cmd } } : {}),
    },
  } as HookEvent
}

const SUBAGENT_ID = 'ae246e3461af00873'

describe('real CC 2.1.209 background-subagent capture', () => {
  it('sanity: the capture actually contains interleaved parent work', () => {
    // Guards the fixture itself -- if a future recapture loses the interleaving
    // this test stops proving anything, so fail loudly rather than pass vacuously.
    const startIdx = CAPTURE.findIndex(c => c.hook_event_name === 'SubagentStart')
    const stopIdx = CAPTURE.findIndex(c => c.hook_event_name === 'SubagentStop')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(stopIdx).toBeGreaterThan(startIdx)
    const parentHooksInsideWindow = CAPTURE.slice(startIdx + 1, stopIdx).filter(
      c => !c.agent_id && c.cmd?.startsWith('echo PARENT'),
    )
    expect(parentHooksInsideWindow.length).toBeGreaterThanOrEqual(5)
  })

  it('attributes every parent `echo PARENT_*` hook to the PARENT, not the subagent', () => {
    const parentToolHooks = CAPTURE.filter(c => c.cmd?.startsWith('echo PARENT'))
    expect(parentToolHooks.length).toBe(6)
    for (const c of parentToolHooks) {
      expect(resolveSubagentAttribution(toHookEvent(c))).toBeUndefined()
    }
  })

  it("attributes the subagent's own Bash hooks to the subagent", () => {
    const subagentToolHooks = CAPTURE.filter(c => c.cmd?.startsWith('sleep 25'))
    expect(subagentToolHooks.length).toBe(2)
    for (const c of subagentToolHooks) {
      expect(resolveSubagentAttribution(toHookEvent(c))).toBe(SUBAGENT_ID)
    }
  })

  it('keeps roster lifecycle + the parent spawn call on the parent', () => {
    const parentRouted = CAPTURE.filter(
      c =>
        c.hook_event_name === 'SubagentStart' ||
        c.hook_event_name === 'SubagentStop' ||
        c.hook_event_name === 'SessionStart' ||
        c.hook_event_name === 'Stop' ||
        c.tool_name === 'Agent',
    )
    for (const c of parentRouted) {
      expect(resolveSubagentAttribution(toHookEvent(c))).toBeUndefined()
    }
  })

  it('splits the whole capture cleanly: 11 parent, 2 subagent, 2 lifecycle', () => {
    const attributed = CAPTURE.map(c => resolveSubagentAttribution(toHookEvent(c)))
    expect(attributed.filter(a => a === undefined)).toHaveLength(13)
    expect(attributed.filter(a => a === SUBAGENT_ID)).toHaveLength(2)
  })
})
