/**
 * The pulse PROJECTION, pinned.
 *
 * `pulseRowFromSummary` reads fifteen fields off a ~100-field
 * `ConversationSummary` and every optional one of them is omit-when-absent. That
 * is exactly the kind of rule nothing notices breaking: a field that silently
 * stops being projected renders as a blank column on P1, which looks like a
 * quiet conversation rather than a bug. Until this file existed the projection
 * had no direct test at all.
 *
 * IT IS TESTED THROUGH THE SEED, not by importing the function. The projection
 * is module-private on purpose (nothing outside `wall-sources.ts` reads it), and
 * the seed is the path that actually matters: `attachWallSources` installs it,
 * the hub fires it on the 0->1 subscriber transition, and the rows come back on
 * the `full: true` snapshot frame -- delivered synchronously by `subscribe()`,
 * so no timer runs here.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import type { ConversationSummary } from '../../shared/protocol'
import type { WallFrame, WallPulseRow } from '../../shared/wall'
import { wallHub } from './index'
import type { WallSocket } from './wall-hub'
import { attachWallSources, pushWallPulse, wallCommitFromRow } from './wall-sources'

/**
 * KEYS are checked, VALUES are stubs.
 *
 * The projection reads fifteen fields off a ~100-field summary, and several of
 * those fields are themselves large records (`LiveStatus` wants a `seq`, an
 * epic tag is a whole object) whose other members the projection never looks at.
 * Building them in full would bury what each case is about, so the value type is
 * loosened while `keyof ConversationSummary` keeps the KEY honest -- and the key
 * is the half worth protecting, because a mistyped one would leave a test that
 * passes while asserting nothing.
 */
type SummaryOver = Partial<Record<keyof ConversationSummary, unknown>>

function summary(over: SummaryOver): ConversationSummary {
  return {
    id: 'conv-0001-aaaa',
    project: 'claude://default/repo',
    title: 'a title',
    status: 'active',
    lastActivity: 1_700_000_000_000,
    ...over,
  } as unknown as ConversationSummary
}

/** A socket that keeps the frames it was handed. */
function fakeSocket() {
  const frames: WallFrame[] = []
  return {
    frames,
    send(json: string) {
      frames.push(JSON.parse(json) as WallFrame)
      return json.length
    },
    getBufferedAmount: () => 0,
  }
}

/**
 * Subscribe a fresh socket to an EMPTY hub and hand back its frames.
 *
 * The reset is not ceremony: the seed fires only on the 0->1 transition, so a
 * second subscribe against a live hub is served the FIRST subscriber's snapshot
 * and a test that seeded new summaries would silently assert against the old
 * ones. (It did, until this line.)
 */
function freshSocket(): ReturnType<typeof fakeSocket> {
  wallHub.reset()
  const ws = fakeSocket()
  wallHub.subscribe(ws as unknown as WallSocket)
  return ws
}

/** Seed the hub with these summaries and return the snapshot's pulse rows. */
function seededRows(summaries: ConversationSummary[]): WallPulseRow[] {
  attachWallSources(() => summaries)
  return freshSocket().frames[0]?.pulse?.changed ?? []
}

function onlyRow(over: SummaryOver): WallPulseRow {
  const rows = seededRows([summary(over)])
  expect(rows).toHaveLength(1)
  return rows[0] as WallPulseRow
}

afterEach(() => {
  wallHub.reset()
  attachWallSources(() => [])
})

describe('pulse projection', () => {
  it('carries the five fields every row must have', () => {
    const row = onlyRow({ id: 'conv-x', project: 'p', title: 'T', status: 'idle', lastActivity: 42 })
    expect(row).toEqual({ id: 'conv-x', project: 'p', title: 'T', status: 'idle', lastActivity: 42 })
  })

  it('OMITS every optional field it has no value for, rather than sending null', () => {
    const row = onlyRow({})
    // `toEqual` ignores undefined-valued keys, so the shape is asserted on the
    // key list itself -- an `undefined` leaking onto the wire is the bug.
    expect(Object.keys(row).sort()).toEqual(['id', 'lastActivity', 'project', 'status', 'title'])
  })

  it('projects each optional field when the summary has it', () => {
    const row = onlyRow({
      lastInputAt: 7,
      stats: { totalCostUsd: 1.5 },
      autocompactPct: 63,
      model: 'claude-opus-5',
      liveStatus: { state: 'thinking' },
      turnSummary: { detail: 'running tests' },
    })
    expect(row.lastInputAt).toBe(7)
    expect(row.costUsd).toBe(1.5)
    expect(row.contextPct).toBe(63)
    expect(row.model).toBe('claude-opus-5')
    expect(row.liveStatus).toBe('thinking')
    expect(row.classified).toBe('running tests')
  })

  it('falls back through agentName, summary and a short id for the title', () => {
    expect(onlyRow({ title: '', agentName: 'reviewer' }).title).toBe('reviewer')
    expect(onlyRow({ title: '', agentName: '', summary: 'what it did' }).title).toBe('what it did')
    expect(onlyRow({ id: 'abcdefgh-and-more', title: '', agentName: '', summary: '' }).title).toBe('abcdefgh')
  })

  it('prefers the sentinel alias over its id, and falls THROUGH an empty alias', () => {
    expect(onlyRow({ hostSentinelAlias: 'studio', hostSentinelId: 'sent-1' }).host).toBe('studio')
    expect(onlyRow({ hostSentinelId: 'sent-1' }).host).toBe('sent-1')
    // The pre-2026-08-20 projection sent `''` here (it guarded with `||` and
    // then picked with `??`). A blank host label was never the answer.
    expect(onlyRow({ hostSentinelAlias: '', hostSentinelId: 'sent-1' }).host).toBe('sent-1')
    expect(onlyRow({}).host).toBeUndefined()
  })

  it('treats an empty model, live status or classification as absent', () => {
    const row = onlyRow({ model: '', liveStatus: { state: '' }, turnSummary: { detail: '' } })
    expect(Object.keys(row)).not.toContain('model')
    expect(Object.keys(row)).not.toContain('liveStatus')
    expect(Object.keys(row)).not.toContain('classified')
  })

  it('marks a run MANAGED only from the launch tag, never from self-report', () => {
    expect(onlyRow({ epic: { epicId: 'epic-the-wall-ii' } }).managed).toBe(true)
    expect(onlyRow({ nightshift: { runId: 'r', taskId: 't' } }).managed).toBe(true)
    // A conversation that merely SAYS it is managed is not: the tag is set at
    // launch, by the dispatcher, out of the agent's reach.
    expect(onlyRow({ liveStatus: { state: 'managed' } }).managed).toBeUndefined()
  })

  it('reports BLOCKED for each of the three hard blocks, and only those', () => {
    expect(onlyRow({ pendingAttention: { timestamp: 1 } }).blocked).toBe(true)
    expect(onlyRow({ pendingSpawnApproval: { requestId: 'r' } }).blocked).toBe(true)
    expect(onlyRow({ turnSummary: { category: 'blocked' } }).blocked).toBe(true)
    expect(onlyRow({ turnSummary: { category: 'working' } }).blocked).toBeUndefined()
  })
})

describe('publish seams', () => {
  it('projects one conversation onto a watched wall', () => {
    attachWallSources(() => [])
    const ws = freshSocket()
    pushWallPulse(summary({ id: 'late-arrival', title: 'showed up after subscribe' }))
    wallHub.tick()
    expect(ws.frames[1]?.pulse?.changed.map(r => r.id)).toEqual(['late-arrival'])
  })

  it('does NO projection work while nobody is watching', () => {
    // The gate is the point: `wallActive()` is false here, so the row is never
    // built and never accumulates. Proven by subscribing AFTER the push and
    // finding the snapshot empty rather than carrying it.
    attachWallSources(() => [])
    wallHub.reset()
    pushWallPulse(summary({ id: 'shouted-into-the-void' }))
    expect(freshSocket().frames[0]?.pulse?.changed).toEqual([])
  })
})

describe('commit projection', () => {
  it('omits the two optional conversation fields when the commit has no conversation', () => {
    const row = wallCommitFromRow({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      repoUri: 'claude://default/repo',
      repoName: 'repo',
      branch: 'main',
      subject: 'fix the thing',
      authorName: 'Jonas Frost',
      insertions: 3,
      deletions: 1,
      fileCount: 2,
      committedAt: 1_700_000_000_000,
    } as unknown as Parameters<typeof wallCommitFromRow>[0])
    expect(Object.keys(row)).not.toContain('conversationId')
    expect(Object.keys(row)).not.toContain('conversationName')
    expect(row.shortHash).toBe('aaaaaaa')
  })
})
