/**
 * REGRESSION (plan-dispatcher-brain.md P4 / DISPATCHER-REPORTBACK): EVERY
 * dispatcher-initiated spawn must carry the report-back contract. There must be
 * NO fire-and-forget spawn verb -- the dispatcher's only spawn is `dispatch_quest`
 * (quest registration + report-back prompt + parked <pending> block). The unique
 * capability the removed `spawn_into_project` had -- resolving a named project and
 * spawning into it even with ZERO live conversations -- is covered by dispatch_quest.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation } from '../../shared/protocol'
import { closeProjectStore, getOrCreateProject, initProjectStore } from '../project-store'
import { buildDispatchToolset } from './dispatch-tools'
import { getUserHistory, resetUserHistory } from './history-store'
import { getBlock } from './living-history'
import { closeProjectMemory, initProjectMemory } from './project-memory'
import { clearQuest, questCount, resolveQuest } from './quest-registry'
import type { QuestSpawn } from './quest-tool'
import type { DispatchRuntime } from './runtime'
import type { ToolContext } from './tool-def'

const ARR = 'claude://default/Users/jonas/projects/arr'
const ctx: ToolContext = { identity: { userId: 'jonas' } }

let dir: string
/** A runtime with NO live conversations -- the empty-project case. */
function emptyRt(): DispatchRuntime {
  return { store: { getAllConversations: () => [] as Conversation[] } } as unknown as DispatchRuntime
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rbc-'))
  initProjectStore(dir)
  initProjectMemory(dir)
  // arr is registered but has ZERO live conversations -- the case spawn_into_project owned.
  getOrCreateProject(ARR, 'arr')
  resetUserHistory('jonas')
})
afterEach(() => {
  // quest-registry is a process-global; don't leak our worker into sibling suites
  // (async-impulse asserts an absolute questCount() === 0).
  clearQuest('conv_empty_worker')
  closeProjectMemory()
  closeProjectStore()
  rmSync(dir, { recursive: true, force: true })
})

describe('report-back contract: no fire-and-forget spawn', () => {
  test('the toolset exposes NO fire-and-forget spawn verb', () => {
    const tools = buildDispatchToolset(emptyRt())
    // The two fire-and-forget escape hatches must both be gone.
    expect(tools.spawn).toBeUndefined()
    expect(tools.spawn_into_project).toBeUndefined()
    // dispatch_quest -- the report-back-carrying spawn -- is the only spawn verb.
    expect(tools.dispatch_quest).toBeDefined()
  })

  test('dispatch_quest spawns into a project with ZERO live conversations + registers a quest + parks <pending>', async () => {
    let sawProjectUri: string | undefined
    let sawCwd: string | null | undefined
    let sawReportBack = false
    const spawn: QuestSpawn = async req => {
      sawProjectUri = req.projectUri
      sawCwd = req.cwd
      // the worker is told to report back and exit -- the report-back contract
      sawReportBack =
        req.intent.includes('send_message') &&
        req.intent.includes('dispatcher') &&
        req.intent.includes('exit_conversation')
      return { conversationId: 'conv_empty_worker' }
    }
    const tools = buildDispatchToolset(emptyRt(), false, spawn)
    const out = (await tools.dispatch_quest.execute(
      { project: 'arr', task: 'find this week sci-fi releases', complexity: 'simple' },
      ctx,
    )) as { conversationId?: string; pendingId?: string }

    // resolved the named project + spawned into it despite no live conversation
    expect(sawProjectUri).toBe(ARR)
    // SPAWN TARGET is the path-backed cwd (the sentinel can't expand a claude:// URI;
    // passing the URI was the live "Directory not found" bug folding spawn_into_project
    // into dispatch_quest had left open).
    expect(sawCwd).toBe('/Users/jonas/projects/arr')
    expect(out.conversationId).toBe('conv_empty_worker')
    // the report-back contract rode along
    expect(sawReportBack).toBe(true)
    // a quest is registered against the worker (the report-back key)
    expect(resolveQuest('conv_empty_worker')).toMatchObject({ userId: 'jonas' })
    expect(questCount()).toBeGreaterThan(0)
    // a <pending> block is parked in the user's living history
    const pending = getBlock(getUserHistory('jonas'), out.pendingId as string)
    expect(pending?.tag).toBe('pending')
    expect(pending?.content).toContain('find this week sci-fi releases')
  })
})
