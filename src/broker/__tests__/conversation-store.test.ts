/**
 * Behavioral tests for session-store public API.
 *
 * Black-box tests on the SessionStore interface returned by createSessionStore().
 * Tests must pass on the current (pre-split) code and serve as a safety net for
 * any future structural refactoring.
 *
 * Constructed with enablePersistence: false to skip all disk I/O.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { deriveModelName } from '../../shared/models'
import type { HookEvent, TaskInfo, TranscriptEntry } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { createConversationStore, isEvictableDaemonGhost } from '../conversation-store'
import { createStore } from '../store'

// Minimal mock socket -- used only for identity / set membership.
// No actual send() calls reach these in non-persistence, no-subscriber mode
// because broadcastConversationScoped iterates an empty controlPanelSubscribers set.
function mockSocket(id = Math.random().toString()): ServerWebSocket<unknown> {
  return {
    _id: id,
    data: {},
    send: () => 0,
    close: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    publish: () => false,
    terminate: () => {},
    ping: () => {},
    pong: () => {},
    readyState: 1,
    remoteAddress: '127.0.0.1',
    binaryType: 'nodebuffer',
    bufferedAmount: 0,
  } as unknown as ServerWebSocket<unknown>
}

function makeHookEvent(
  sessionId: string,
  hookEvent: HookEvent['hookEvent'] = 'UserPromptSubmit',
  overrides: Partial<HookEvent> = {},
): HookEvent {
  return {
    type: 'hook',
    conversationId: sessionId,
    hookEvent,
    timestamp: Date.now(),
    data: { conversation_id: sessionId },
    ...overrides,
  }
}

function makeTranscriptEntry(type: string = 'user'): TranscriptEntry {
  return { type } as TranscriptEntry
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let store: ConversationStore

beforeEach(() => {
  store = createConversationStore({ enablePersistence: false })
})

// ---------------------------------------------------------------------------
// 1. Conversation lifecycle
// ---------------------------------------------------------------------------

describe('conversation lifecycle', () => {
  it('createConversation returns a conversation accessible via getConversation', () => {
    store.createConversation('sess-1', '/home/user/project')
    const conv = store.getConversation('sess-1')
    expect(conv).toBeDefined()
    expect(conv!.id).toBe('sess-1')
    expect(conv!.project).toBe('claude://default/home/user/project')
  })

  it('createConversation makes conversation appear in getAllConversations', () => {
    store.createConversation('sess-a', '/cwd/a')
    store.createConversation('sess-b', '/cwd/b')
    const all = store.getAllConversations()
    expect(all.map(s => s.id)).toContain('sess-a')
    expect(all.map(s => s.id)).toContain('sess-b')
  })

  it('createConversation makes conversation appear in getActiveConversations (status is not ended)', () => {
    store.createConversation('sess-active', '/cwd')
    const active = store.getActiveConversations()
    expect(active.map(s => s.id)).toContain('sess-active')
  })

  it('createConversation called twice with same id returns existing conversation without duplicate', () => {
    const first = store.createConversation('dup-id', '/cwd')
    // Second call -- conversation already exists, so it goes straight through conversations.set(id, conversation)
    // The implementation does NOT check for existence; it overwrites but the original conversation is gone.
    // Read actual code: conversations.set(id, conversation) -- it creates a NEW conversation object every time.
    // Verify via getAllConversations that only one entry exists with that id.
    store.createConversation('dup-id', '/cwd')
    const all = store.getAllConversations()
    const withId = all.filter(s => s.id === 'dup-id')
    // The implementation overwrites, so there is still exactly one entry
    expect(withId).toHaveLength(1)
    // The returned conversation from first call is now replaced -- second createConversation wins
    expect(first.id).toBe('dup-id')
  })

  it('endConversation moves conversation out of getActiveConversations but keeps it in getAllConversations', () => {
    store.createConversation('end-me', '/cwd')
    store.endConversation('end-me', { source: 'cc-exit-normal' })

    const active = store.getActiveConversations()
    expect(active.map(s => s.id)).not.toContain('end-me')

    const all = store.getAllConversations()
    expect(all.map(s => s.id)).toContain('end-me')
    expect(store.getConversation('end-me')!.status).toBe('ended')
  })

  it('removeConversation removes conversation from everywhere', () => {
    store.createConversation('remove-me', '/cwd')
    store.removeConversation('remove-me')

    expect(store.getConversation('remove-me')).toBeUndefined()
    expect(store.getAllConversations().map(s => s.id)).not.toContain('remove-me')
    expect(store.getActiveConversations().map(s => s.id)).not.toContain('remove-me')
  })

  it('removeConversation cascade-deletes transcript_entries + events (no orphans left)', () => {
    const driver = createStore({ type: 'memory' })
    driver.init()
    const s = createConversationStore({ store: driver, enablePersistence: true })
    s.createConversation('casc-1', '/cwd')

    driver.transcripts.append('casc-1', 'epoch', [
      { type: 'user', uuid: 'c1', content: { text: 'hi' }, timestamp: Date.now() },
      { type: 'assistant', uuid: 'c2', content: { text: 'yo' }, timestamp: Date.now() },
    ])
    driver.events.append('casc-1', { type: 'SessionStart' })
    expect(driver.transcripts.count('casc-1')).toBe(2)
    expect(driver.events.getForConversation('casc-1')).toHaveLength(1)

    s.removeConversation('casc-1')

    // The whole point: deleting the conversation leaves no orphaned child rows.
    expect(driver.transcripts.count('casc-1')).toBe(0)
    expect(driver.events.getForConversation('casc-1')).toHaveLength(0)
    expect(driver.conversations.get('casc-1')).toBeNull()
  })

  it('addTranscriptEntries refuses to persist for an unregistered conversation (orphan write guard)', () => {
    const driver = createStore({ type: 'memory' })
    driver.init()
    const s = createConversationStore({ store: driver, enablePersistence: true })

    // 'ghost' was never createConversation'd. Persisting its entries would strand
    // invisible orphan transcript_entries -- the guard must skip the write.
    s.addTranscriptEntries('ghost', [makeTranscriptEntry('user')], false)
    expect(driver.transcripts.count('ghost')).toBe(0)

    // Positive control: a registered conversation still persists normally.
    s.createConversation('real', '/cwd')
    s.addTranscriptEntries('real', [makeTranscriptEntry('user')], false)
    expect(driver.transcripts.count('real')).toBe(1)
  })

  it('resumeConversation on an ended conversations restores it to active conversations', () => {
    store.createConversation('resume-me', '/cwd')
    store.endConversation('resume-me', { source: 'cc-exit-normal' })
    expect(store.getActiveConversations().map(s => s.id)).not.toContain('resume-me')

    store.resumeConversation('resume-me')
    expect(store.getActiveConversations().map(s => s.id)).toContain('resume-me')
    expect(store.getConversation('resume-me')!.status).toBe('idle')
  })

  it('resumeConversation on an active/idle conv preserves lastActivity (no reconnect overwrite)', () => {
    const conv = store.createConversation('resume-active', '/cwd')
    // Pin lastActivity to an old timestamp -- simulates real activity from 30
    // minutes ago. A reconnect (meta arrival) must NOT overwrite this; the
    // dashboard "last activity" column depends on it.
    const realLastActivity = Date.now() - 30 * 60_000
    conv.lastActivity = realLastActivity
    conv.status = 'idle'

    store.resumeConversation('resume-active')

    expect(store.getConversation('resume-active')!.lastActivity).toBe(realLastActivity)
  })

  it('resumeConversation on an ENDED conv PRESERVES lastActivity (un-end is transport, not activity)', () => {
    // Regression: un-ending must NOT re-stamp lastActivity to now(). The
    // dominant un-end is a broker restart -- rehydrateFromStore loads every
    // conversation as 'ended', so the first reconnect of each one un-ends it.
    // Stamping now() here re-dated the entire roster to the restart moment (the
    // "3m ago across the board" last-activity bug). Real work re-stamps via
    // hook events; the un-end itself must keep the true timestamp.
    const conv = store.createConversation('resume-ended', '/cwd')
    const realLastActivity = Date.now() - 30 * 60_000
    conv.lastActivity = realLastActivity
    store.endConversation('resume-ended', { source: 'cc-exit-normal' })

    store.resumeConversation('resume-ended')

    expect(store.getConversation('resume-ended')!.lastActivity).toBe(realLastActivity)
  })

  it('broker restart + reconnect preserves each conversation true lastActivity (no uniform re-stamp)', () => {
    // The real-world repro of the "3m ago across the board" bug. A broker
    // restart rehydrates the whole roster as 'ended'; the agent hosts then
    // reconnect and each conversation un-ends. Pre-fix, that re-stamped every
    // lastActivity to the restart moment, so the batch view's last-activity
    // column showed the reconnect time for everything. Each conversation must
    // keep its own true, distinct timestamp.
    const driver = createStore({ type: 'memory' })
    driver.init()
    const before = createConversationStore({ store: driver, enablePersistence: true })

    const now = Date.now()
    const ages = { a: now - 90 * 60_000, b: now - 5 * 60_000, c: now - 3 * 24 * 60_000 }
    for (const [id, ts] of Object.entries(ages)) {
      const c = before.createConversation(id, '/cwd')
      c.lastActivity = ts
      before.persistConversationById(id)
    }

    // Simulate the restart: a fresh store loads from the same driver. Every
    // conversation comes back as 'ended' with its persisted lastActivity.
    const after = createConversationStore({ store: driver, enablePersistence: true })
    for (const id of Object.keys(ages)) {
      expect(after.getConversation(id)!.status).toBe('ended')
    }

    // Reconnect: each conversation un-ends. lastActivity must survive verbatim.
    for (const id of Object.keys(ages)) {
      after.resumeConversation(id)
    }
    expect(after.getConversation('a')!.lastActivity).toBe(ages.a)
    expect(after.getConversation('b')!.lastActivity).toBe(ages.b)
    expect(after.getConversation('c')!.lastActivity).toBe(ages.c)
  })

  it('maintenance reaper does NOT mark subagents stopped on a long-idle conv that still has a live socket', () => {
    const conv = store.createConversation('reaper-with-socket', '/cwd')
    // Old lastActivity (45m ago) -- pre-fix, the reaper would have killed
    // running subagents based on this alone. Post-fix, a live socket gates
    // the cleanup so we don't kill subagents on reconnected conversations.
    conv.lastActivity = Date.now() - 45 * 60_000
    conv.subagents.push({
      agentId: 'sa-1',
      agentType: 'general',
      startedAt: Date.now() - 45 * 60_000,
      status: 'running',
      events: [],
    })
    const ws = mockSocket()
    store.setConversationSocket('reaper-with-socket', 'conn-1', ws)

    store._runMaintenancePassForTesting()

    const subagent = store.getConversation('reaper-with-socket')!.subagents[0]
    expect(subagent.status).toBe('running')
    expect(subagent.stoppedAt).toBeUndefined()
  })

  it('maintenance reaper marks stale subagents stopped when no live socket (agent host gone)', () => {
    const conv = store.createConversation('reaper-no-socket', '/cwd')
    conv.lastActivity = Date.now() - 45 * 60_000
    conv.subagents.push({
      agentId: 'sa-1',
      agentType: 'general',
      startedAt: Date.now() - 45 * 60_000,
      status: 'running',
      events: [],
    })
    // No socket registered: agent host is gone, so any "running" subagent is
    // a zombie that should be cleaned up.

    store._runMaintenancePassForTesting()

    const subagent = store.getConversation('reaper-no-socket')!.subagents[0]
    expect(subagent.status).toBe('stopped')
    expect(subagent.stoppedAt).toBeGreaterThan(0)
  })

  it('getConversation on nonexistent id returns undefined', () => {
    expect(store.getConversation('ghost-session')).toBeUndefined()
  })

  it('clearConversation resets ephemeral state', () => {
    const conv = store.createConversation('conv-1', '/cwd')
    conv.events.push({
      type: 'hook',
      hookEvent: 'SessionStart',
      conversationId: 'conv-1',
      data: {},
      timestamp: Date.now(),
    })

    store.clearConversation('conv-1', '/cwd')

    const cleared = store.getConversation('conv-1')
    expect(cleared).toBeDefined()
    expect(cleared!.id).toBe('conv-1')
    expect(cleared!.events).toEqual([])
    expect(cleared!.status).toBe('idle')
  })

  it('clearConversation resets contextMode so stale standard does not suppress [1m]', () => {
    const conv = store.createConversation('ctx-mode-clear', '/cwd')
    conv.contextMode = 'standard'

    store.clearConversation('ctx-mode-clear', '/cwd')

    const cleared = store.getConversation('ctx-mode-clear')
    expect(cleared!.contextMode).toBeUndefined()
  })

  it('updateActivity updates conversation lastActivity timestamp', async () => {
    store.createConversation('act-test', '/cwd')
    const before = store.getConversation('act-test')!.lastActivity

    // Guarantee time advance
    await new Promise(r => setTimeout(r, 2))
    store.updateActivity('act-test')

    const after = store.getConversation('act-test')!.lastActivity
    expect(after).toBeGreaterThan(before)
  })
})

// ---------------------------------------------------------------------------
// 2. Event ingestion
// ---------------------------------------------------------------------------

describe('event ingestion', () => {
  it('addEvent on an existing conversation stores the event in getConversationEvents', () => {
    store.createConversation('ev-sess', '/cwd')
    const event = makeHookEvent('ev-sess', 'UserPromptSubmit')
    store.addEvent('ev-sess', event)

    const events = store.getConversationEvents('ev-sess')
    expect(events).toHaveLength(1)
    expect(events[0].hookEvent).toBe('UserPromptSubmit')
  })

  it('addEvent on a missing conversation does not crash', () => {
    const event = makeHookEvent('ghost', 'UserPromptSubmit')
    // Should not throw -- event is silently dropped
    expect(() => store.addEvent('ghost', event)).not.toThrow()
    expect(store.getConversationEvents('ghost')).toHaveLength(0)
  })

  it('getConversationEvents with limit returns last N events', () => {
    store.createConversation('limit-sess', '/cwd')
    for (let i = 0; i < 10; i++) {
      store.addEvent('limit-sess', makeHookEvent('limit-sess', 'UserPromptSubmit', { timestamp: i }))
    }
    const last3 = store.getConversationEvents('limit-sess', 3)
    expect(last3).toHaveLength(3)
    // Should be the last 3 (highest timestamps)
    expect(last3[2].timestamp).toBe(9)
  })

  it('getConversationEvents with since returns only events after that timestamp', () => {
    store.createConversation('since-sess', '/cwd')
    for (let i = 0; i < 5; i++) {
      store.addEvent('since-sess', makeHookEvent('since-sess', 'UserPromptSubmit', { timestamp: i * 100 }))
    }
    // Timestamps: 0, 100, 200, 300, 400 -- since=150 should return 200, 300, 400
    const events = store.getConversationEvents('since-sess', undefined, 150)
    expect(events).toHaveLength(3)
    expect(events[0].timestamp).toBe(200)
  })

  it('addEvent with Stop hook transitions conversation status to idle', () => {
    store.createConversation('stop-sess', '/cwd')
    store.addEvent('stop-sess', makeHookEvent('stop-sess', 'Stop'))
    expect(store.getConversation('stop-sess')!.status).toBe('idle')
  })

  it('addEvent with non-passive hook (UserPromptSubmit) transitions conversation status to active', () => {
    store.createConversation('prompt-sess', '/cwd')
    // Start in 'starting' status, a non-passive event should flip to 'active'
    store.addEvent('prompt-sess', makeHookEvent('prompt-sess', 'UserPromptSubmit'))
    expect(store.getConversation('prompt-sess')!.status).toBe('active')
  })

  it('updateTasks replaces conversation tasks', () => {
    store.createConversation('task-sess', '/cwd')
    const tasks: TaskInfo[] = [
      { id: 'task-1', subject: 'Do something', status: 'pending', updatedAt: Date.now() },
      { id: 'task-2', subject: 'Do another', status: 'in_progress', updatedAt: Date.now() },
    ]
    store.updateTasks('task-sess', tasks)
    const conv = store.getConversation('task-sess')!
    expect(conv.tasks).toHaveLength(2)
    expect(conv.tasks[0].id).toBe('task-1')
    expect(conv.tasks[1].status).toBe('in_progress')
  })
})

// ---------------------------------------------------------------------------
// 3. Transcript cache
// ---------------------------------------------------------------------------

describe('transcript cache', () => {
  it('hasTranscriptCache returns false before any entries are added', () => {
    store.createConversation('tc-sess', '/cwd')
    expect(store.hasTranscriptCache('tc-sess')).toBe(false)
  })

  it('addTranscriptEntries with isInitial=true stores entries, hasTranscriptCache returns true', () => {
    store.createConversation('tc-init', '/cwd')
    const entries = [makeTranscriptEntry('user'), makeTranscriptEntry('assistant')]
    store.addTranscriptEntries('tc-init', entries, true)

    expect(store.hasTranscriptCache('tc-init')).toBe(true)
    const cached = store.getTranscriptEntries('tc-init')
    expect(cached).toHaveLength(2)
  })

  it('getTranscriptEntries with limit returns last N entries', () => {
    store.createConversation('tc-limit', '/cwd')
    const entries = Array.from({ length: 10 }, (_, i) => ({ type: 'user', _i: i }) as unknown as TranscriptEntry)
    store.addTranscriptEntries('tc-limit', entries, true)

    const last3 = store.getTranscriptEntries('tc-limit', 3)
    expect(last3).toHaveLength(3)
    // Last 3 entries (indices 7, 8, 9)
    expect((last3[2] as unknown as { _i: number })._i).toBe(9)
  })

  it('addTranscriptEntries with isInitial=false appends to existing cache', () => {
    store.createConversation('tc-append', '/cwd')
    store.addTranscriptEntries('tc-append', [makeTranscriptEntry('user')], true)
    store.addTranscriptEntries('tc-append', [makeTranscriptEntry('assistant')], false)

    const cached = store.getTranscriptEntries('tc-append')
    expect(cached).toHaveLength(2)
    expect(cached[0].type).toBe('user')
    expect(cached[1].type).toBe('assistant')
  })

  // CONTRACT CHANGE (transcript-cache-write.ts): isInitial RECONCILES, it does
  // not replace. Replacing was a data-loss bug -- a headless resend is read from
  // CC's JSONL and narrowed by the host's forward policy, so it never carries
  // the stdout-only entries, and swapping the cache for it deleted them.
  it('addTranscriptEntries with isInitial=true reconciles rather than replacing', () => {
    store.createConversation('tc-replace', '/cwd')
    store.addTranscriptEntries('tc-replace', [makeTranscriptEntry('user')], true)
    // A second initial load brings two entries the cache did not hold.
    store.addTranscriptEntries('tc-replace', [makeTranscriptEntry('assistant'), makeTranscriptEntry('user')], true)

    const cached = store.getTranscriptEntries('tc-replace')
    expect(cached).toHaveLength(3)
    expect(cached.map(e => e.type)).toEqual(['user', 'assistant', 'user'])
  })

  it('subagent: hasSubagentTranscriptCache returns false before entries added', () => {
    store.createConversation('sub-sess', '/cwd')
    expect(store.hasSubagentTranscriptCache('sub-sess', 'agent-1')).toBe(false)
  })

  it('subagent: addSubagentTranscriptEntries stores entries, getSubagentTranscriptEntries returns them', () => {
    store.createConversation('sub-sess', '/cwd')
    const entries = [makeTranscriptEntry('user'), makeTranscriptEntry('assistant')]
    store.addSubagentTranscriptEntries('sub-sess', 'agent-1', entries, true)

    expect(store.hasSubagentTranscriptCache('sub-sess', 'agent-1')).toBe(true)
    const cached = store.getSubagentTranscriptEntries('sub-sess', 'agent-1')
    expect(cached).toHaveLength(2)
  })

  it('subagent: caches are keyed by agentId (different agents are independent)', () => {
    store.createConversation('sub-multi', '/cwd')
    store.addSubagentTranscriptEntries('sub-multi', 'agent-A', [makeTranscriptEntry('user')], true)
    store.addSubagentTranscriptEntries('sub-multi', 'agent-B', [makeTranscriptEntry('assistant')], true)

    expect(store.getSubagentTranscriptEntries('sub-multi', 'agent-A')[0].type).toBe('user')
    expect(store.getSubagentTranscriptEntries('sub-multi', 'agent-B')[0].type).toBe('assistant')
  })
})

// ---------------------------------------------------------------------------
// 4. Channel pub/sub
// ---------------------------------------------------------------------------

describe('channel pub/sub', () => {
  it('subscribeChannel adds ws to getChannelSubscribers', () => {
    store.createConversation('ch-sess', '/cwd')
    const ws = mockSocket()
    // Must be a registered subscriber for the reverse index to work properly
    // (subscribeChannel does track via subscriberRegistry but getChannelSubscribers
    //  uses the forward index directly -- no subscriber registry required)
    store.subscribeChannel(ws, 'conversation:events', 'ch-sess')

    const subs = store.getChannelSubscribers('conversation:events', 'ch-sess')
    expect(subs.has(ws)).toBe(true)
  })

  it('unsubscribeChannel removes ws from getChannelSubscribers', () => {
    store.createConversation('ch-sess2', '/cwd')
    const ws = mockSocket()
    store.subscribeChannel(ws, 'conversation:events', 'ch-sess2')
    store.unsubscribeChannel(ws, 'conversation:events', 'ch-sess2')

    const subs = store.getChannelSubscribers('conversation:events', 'ch-sess2')
    expect(subs.has(ws)).toBe(false)
  })

  it('unsubscribeAllChannels removes ws from all channels it subscribed to', () => {
    store.createConversation('ch-multi', '/cwd')
    const ws = mockSocket()
    // Register in subscriber registry first so unsubscribeAllChannels can find the channels
    store.addSubscriber(ws, 2)

    store.subscribeChannel(ws, 'conversation:events', 'ch-multi')
    store.subscribeChannel(ws, 'conversation:transcript', 'ch-multi')

    store.unsubscribeAllChannels(ws)

    expect(store.getChannelSubscribers('conversation:events', 'ch-multi').has(ws)).toBe(false)
    expect(store.getChannelSubscribers('conversation:transcript', 'ch-multi').has(ws)).toBe(false)
  })

  it('getSubscriptionsDiag reflects subscription state', () => {
    store.createConversation('diag-sess', '/cwd')
    const ws = mockSocket()
    store.addSubscriber(ws, 2)
    store.subscribeChannel(ws, 'conversation:events', 'diag-sess')

    const diag = store.getSubscriptionsDiag()
    expect(diag.summary.totalSubscribers).toBeGreaterThanOrEqual(1)
    expect(diag.summary.v2Subscribers).toBeGreaterThanOrEqual(1)
    // Channel counts should include our subscription
    const eventCount = diag.summary.channelCounts['conversation:events']
    expect(eventCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Sync state
// ---------------------------------------------------------------------------

describe('sync state', () => {
  it('getSyncState returns epoch (string) and seq (number) on a fresh store', () => {
    const state = store.getSyncState()
    expect(typeof state.epoch).toBe('string')
    expect(state.epoch.length).toBeGreaterThan(0)
    expect(typeof state.seq).toBe('number')
  })

  it('seq increments after conversation creation when a subscriber is present (broadcast stamps)', () => {
    // B-H7: with a dashboard subscriber present, createConversation's broadcast
    // stamps + buffers, advancing the sync seq.
    const ws = mockSocket()
    store.addSubscriber(ws, 2)
    const before = store.getSyncState().seq
    store.createConversation('seq-sess', '/cwd')
    const after = store.getSyncState().seq
    expect(after).toBeGreaterThan(before)
  })

  it('seq is frozen when there are no subscribers (B-H7: ring buffering skipped)', () => {
    // No dashboards => the sync ring is dead weight; a future reconnect resyncs
    // from a fresh snapshot stamped with the current seq. So broadcasts skip
    // stamp+buffer entirely and seq does not advance. This is safe precisely
    // because any connected client makes the subscriber set non-empty.
    const before = store.getSyncState().seq
    store.createConversation('seq-sess-empty', '/cwd')
    const after = store.getSyncState().seq
    expect(after).toBe(before)
  })

  it('handleSyncCheck with matching epoch and current seq responds sync_ok', () => {
    store.createConversation('sync-sess', '/cwd')
    const { epoch, seq } = store.getSyncState()

    const received: string[] = []
    const ws = {
      ...mockSocket(),
      data: {},
      send: (msg: string) => {
        received.push(msg)
        return 0
      },
    } as unknown as ServerWebSocket<unknown>

    store.handleSyncCheck(ws, epoch, seq)

    expect(received).toHaveLength(1)
    const response = JSON.parse(received[0])
    expect(response.type).toBe('sync_ok')
  })

  it('handleSyncCheck with mismatched epoch responds sync_stale', () => {
    const received: string[] = []
    const ws = {
      ...mockSocket(),
      data: {},
      send: (msg: string) => {
        received.push(msg)
        return 0
      },
    } as unknown as ServerWebSocket<unknown>

    store.handleSyncCheck(ws, 'wrong-epoch', 0)

    expect(received).toHaveLength(1)
    const response = JSON.parse(received[0])
    expect(response.type).toBe('sync_stale')
    expect(response.reason).toBe('epoch_changed')
  })
})

// ---------------------------------------------------------------------------
// 5b. Summary cache invalidation (B-H1 / B-H2)
//
// The cache is observed through the conversations_list snapshot, which is the
// path that reuses the cached per-conversation JSON fragment. Every test mutates
// a conversation and asserts the snapshot reflects the change -- i.e. the cache
// was invalidated. A stale summary here = silently-wrong control-panel UI.
// ---------------------------------------------------------------------------

describe('summary cache invalidation', () => {
  function snapshot(): Array<Record<string, unknown>> {
    const out: { conversations?: Array<Record<string, unknown>> } = {}
    const ws = {
      ...mockSocket(),
      data: {},
      send: (m: string) => {
        Object.assign(out, JSON.parse(m))
        return 0
      },
    } as unknown as ServerWebSocket<unknown>
    store.sendConversationsList(ws)
    return out.conversations ?? []
  }
  function summaryOf(id: string): Record<string, unknown> | undefined {
    return snapshot().find(c => c.id === id)
  }

  it('serves a cached fragment but reflects status flips (endConversation)', () => {
    store.createConversation('inv-end', '/cwd')
    expect(summaryOf('inv-end')?.status).not.toBe('ended')
    // Second read with no mutation must still be correct (cache hit).
    expect(summaryOf('inv-end')?.status).not.toBe('ended')
    store.endConversation('inv-end', { source: 'cc-exit-normal' })
    expect(summaryOf('inv-end')?.status).toBe('ended')
  })

  it('reflects task updates (updateTasks -> scheduleConversationUpdate chokepoint)', () => {
    store.createConversation('inv-tasks', '/cwd')
    expect(summaryOf('inv-tasks')?.taskCount).toBe(0)
    store.updateTasks('inv-tasks', [
      { id: 't1', subject: 'a', status: 'pending', updatedAt: Date.now() },
      { id: 't2', subject: 'b', status: 'in_progress', updatedAt: Date.now() },
    ])
    expect(summaryOf('inv-tasks')?.taskCount).toBe(2)
  })

  it('reflects connectionIds changes (setConversationSocket / removeConversationSocket)', () => {
    store.createConversation('inv-sock', '/cwd')
    expect(summaryOf('inv-sock')?.connectionIds).toEqual([])
    const ws = mockSocket()
    store.setConversationSocket('inv-sock', 'conn-1', ws)
    expect(summaryOf('inv-sock')?.connectionIds).toEqual(['conn-1'])
    store.removeConversationSocket('inv-sock', 'conn-1')
    expect(summaryOf('inv-sock')?.connectionIds).toEqual([])
  })

  it('reflects resumeConversation (status back to idle)', () => {
    store.createConversation('inv-resume', '/cwd')
    store.endConversation('inv-resume', { source: 'cc-exit-normal' })
    expect(summaryOf('inv-resume')?.status).toBe('ended')
    store.resumeConversation('inv-resume')
    expect(summaryOf('inv-resume')?.status).toBe('idle')
  })

  it('reflects clearConversation (event count reset)', () => {
    store.createConversation('inv-clear', '/cwd')
    store.addEvent('inv-clear', makeHookEvent('inv-clear', 'UserPromptSubmit'))
    expect((summaryOf('inv-clear')?.eventCount as number) ?? 0).toBeGreaterThan(0)
    store.clearConversation('inv-clear', '/cwd')
    expect(summaryOf('inv-clear')?.eventCount).toBe(0)
  })

  it('drops the entry on removeConversation', () => {
    store.createConversation('inv-remove', '/cwd')
    expect(summaryOf('inv-remove')).toBeDefined()
    store.removeConversation('inv-remove')
    expect(summaryOf('inv-remove')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. Agent Host socket tracking
// ---------------------------------------------------------------------------

describe('conversation socket tracking', () => {
  it('setConversationSocket + getConversationSocket returns the registered socket', () => {
    store.createConversation('sock-sess', '/cwd')
    const ws = mockSocket()
    store.setConversationSocket('sock-sess', 'conv-1', ws)

    const retrieved = store.getConversationSocket('sock-sess')
    expect(retrieved).toBe(ws)
  })

  it('getActiveConversationCount reflects number of registered conversations', () => {
    store.createConversation('wrap-count', '/cwd')
    expect(store.getActiveConversationCount('wrap-count')).toBe(0)

    const ws1 = mockSocket('ws-1')
    const ws2 = mockSocket('ws-2')
    store.setConversationSocket('wrap-count', 'conv-1', ws1)
    store.setConversationSocket('wrap-count', 'conv-2', ws2)

    expect(store.getActiveConversationCount('wrap-count')).toBe(2)
  })

  it('removeConversationSocket decrements conversation count', () => {
    store.createConversation('sock-remove', '/cwd')
    const ws = mockSocket()
    store.setConversationSocket('sock-remove', 'conv-x', ws)
    expect(store.getActiveConversationCount('sock-remove')).toBe(1)

    store.removeConversationSocket('sock-remove', 'conv-x')
    expect(store.getActiveConversationCount('sock-remove')).toBe(0)
    expect(store.getConversationSocket('sock-remove')).toBeUndefined()
  })

  // Regression: silently evicting a still-OPEN orphan WS from the registry
  // on same-key replacement is the root cause of the broker-says-ENDED /
  // host-says-LIVE flap. Boot/meta replace overwrites the slot; if the old
  // WS isn't closed, it stays alive and keeps pumping events while the
  // reaper believes liveSockets=0. setConversationSocket MUST close the
  // orphan with code 4410.
  it('setConversationSocket closes the previous OPEN socket on same-key replacement', () => {
    store.createConversation('orphan-close', '/cwd')
    const ws1 = mockSocket('ws-1')
    let closedCode: number | undefined
    let closedReason: string | undefined
    ws1.close = ((code?: number, reason?: string) => {
      closedCode = code
      closedReason = reason
    }) as ServerWebSocket<unknown>['close']

    store.setConversationSocket('orphan-close', 'orphan-close', ws1)
    const ws2 = mockSocket('ws-2')
    store.setConversationSocket('orphan-close', 'orphan-close', ws2)

    expect(closedCode).toBe(4410)
    expect(closedReason).toBe('orphaned-by-reconnect')
    expect(store.getConversationSocket('orphan-close')).toBe(ws2)
  })

  it('setConversationSocket does NOT call close() on a non-OPEN socket', () => {
    store.createConversation('orphan-already-closed', '/cwd')
    const ws1 = mockSocket('ws-1')
    let closeCalled = false
    ws1.close = (() => {
      closeCalled = true
    }) as ServerWebSocket<unknown>['close']
    // Force CLOSING state to mimic an already-shutting-down socket.
    Object.defineProperty(ws1, 'readyState', { value: 2, writable: true })

    store.setConversationSocket('orphan-already-closed', 'orphan-already-closed', ws1)
    const ws2 = mockSocket('ws-2')
    store.setConversationSocket('orphan-already-closed', 'orphan-already-closed', ws2)

    expect(closeCalled).toBe(false)
    expect(store.getConversationSocket('orphan-already-closed')).toBe(ws2)
  })

  it('setConversationSocket is idempotent for the same socket (no self-close)', () => {
    store.createConversation('orphan-self', '/cwd')
    const ws = mockSocket('ws-self')
    let closeCalled = false
    ws.close = (() => {
      closeCalled = true
    }) as ServerWebSocket<unknown>['close']

    store.setConversationSocket('orphan-self', 'orphan-self', ws)
    store.setConversationSocket('orphan-self', 'orphan-self', ws)

    expect(closeCalled).toBe(false)
    expect(store.getConversationSocket('orphan-self')).toBe(ws)
  })
})

// ---------------------------------------------------------------------------
// conversation.model invariant (guards commit 83a4ce7: dashboard reads conversation.model
// instead of scanning cached SessionStart events per render)
// ---------------------------------------------------------------------------

describe('conversation.model derivation', () => {
  it('SessionStart with data.model sets conversation.model on first arrival', () => {
    store.createConversation('model-1', '/cwd')
    expect(store.getConversation('model-1')!.model).toBeUndefined()

    store.addEvent(
      'model-1',
      makeHookEvent('model-1', 'SessionStart', { data: { conversation_id: 'model-1', model: 'claude-opus-4-7' } }),
    )

    expect(store.getConversation('model-1')!.model).toBe('claude-opus-4-7')
  })

  it('second SessionStart does NOT overwrite an established model (SessionStart is fallback, not ground truth)', () => {
    store.createConversation('model-2', '/cwd')
    store.addEvent(
      'model-2',
      makeHookEvent('model-2', 'SessionStart', { data: { conversation_id: 'model-2', model: 'claude-opus-4-7' } }),
    )
    expect(store.getConversation('model-2')!.model).toBe('claude-opus-4-7')

    // A later SessionStart carrying a DIFFERENT model must NOT clobber the
    // established one. The real model-update paths are stream-json init /
    // conversation_info (transcript.ts) and explicit set_model/reset, which run
    // unconditionally; SessionStart is a last-resort fallback (mirrors the
    // assistant-entry rule). This is what contains the subagent-compaction
    // SessionStart that used to overwrite the parent's model with the
    // subagent's -- see plan-subagent-hook-containment.md.
    store.addEvent(
      'model-2',
      makeHookEvent('model-2', 'SessionStart', { data: { conversation_id: 'model-2', model: 'claude-sonnet-4-6' } }),
    )
    expect(store.getConversation('model-2')!.model).toBe('claude-opus-4-7')
  })

  it('assistant transcript entry sets conversation.model when absent', () => {
    store.createConversation('model-3', '/cwd')
    store.addTranscriptEntries(
      'model-3',
      [{ type: 'assistant', message: { model: 'claude-opus-4-7' } } as TranscriptEntry],
      true,
    )
    expect(store.getConversation('model-3')!.model).toBe('claude-opus-4-7')
  })

  it('assistant transcript entry does NOT overwrite an existing model (fallback only)', () => {
    store.createConversation('model-4', '/cwd')
    store.addEvent(
      'model-4',
      makeHookEvent('model-4', 'SessionStart', { data: { conversation_id: 'model-4', model: 'claude-opus-4-7' } }),
    )
    store.addTranscriptEntries(
      'model-4',
      [{ type: 'assistant', message: { model: 'claude-sonnet-4-6' } } as TranscriptEntry],
      true,
    )
    // Assistant messages are fallback only -- init/SessionStart is ground truth
    expect(store.getConversation('model-4')!.model).toBe('claude-opus-4-7')
  })

  it('<synthetic> assistant entry does NOT clobber a real model', () => {
    store.createConversation('model-5', '/cwd')
    store.addEvent(
      'model-5',
      makeHookEvent('model-5', 'SessionStart', { data: { conversation_id: 'model-5', model: 'claude-opus-4-7' } }),
    )
    store.addTranscriptEntries(
      'model-5',
      [{ type: 'assistant', message: { model: '<synthetic>' } } as TranscriptEntry],
      true,
    )
    expect(store.getConversation('model-5')!.model).toBe('claude-opus-4-7')
  })

  it('<synthetic> assistant entry is always rejected (never sets conversation.model)', () => {
    store.createConversation('model-6', '/cwd')
    store.addTranscriptEntries(
      'model-6',
      [{ type: 'assistant', message: { model: '<synthetic>' } } as TranscriptEntry],
      true,
    )
    // <synthetic> entries are auto-compact summaries / hook-injected messages,
    // not real API turns -- never use them for model tracking
    expect(store.getConversation('model-6')!.model).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 7b. deriveModelName specificity scoring
// ---------------------------------------------------------------------------

describe('deriveModelName', () => {
  it('qualified init beats bare alias', () => {
    expect(deriveModelName('claude-opus-4-7', 'opus')).toBe('claude-opus-4-7')
  })

  it('qualified+suffix beats qualified without', () => {
    expect(deriveModelName('claude-opus-4-6', 'claude-opus-4-6[1m]')).toBe('claude-opus-4-6[1m]')
  })

  it('init wins on tie (same specificity)', () => {
    expect(deriveModelName('claude-opus-4-7', 'claude-sonnet-4-6')).toBe('claude-opus-4-7')
  })

  it('init with suffix beats configuredModel without', () => {
    expect(deriveModelName('claude-opus-4-6[1m]', 'claude-opus-4-6')).toBe('claude-opus-4-6[1m]')
  })

  it('configuredModel with [1m] beats init without (preserves context window info)', () => {
    expect(deriveModelName('claude-opus-4-6', 'claude-opus-4-6[1m]')).toBe('claude-opus-4-6[1m]')
  })

  it('returns a when b is undefined', () => {
    expect(deriveModelName('claude-opus-4-7', undefined)).toBe('claude-opus-4-7')
  })

  it('returns b when a is undefined', () => {
    expect(deriveModelName(undefined, 'opus')).toBe('opus')
  })

  it('returns undefined when both are undefined', () => {
    expect(deriveModelName(undefined, undefined)).toBeUndefined()
  })

  it('dated pin beats plain qualified', () => {
    expect(deriveModelName('claude-opus-4-6', 'claude-opus-4-6-20251101')).toBe('claude-opus-4-6-20251101')
  })

  it('init qualified beats configuredModel bare alias', () => {
    expect(deriveModelName('claude-sonnet-4-6', 'sonnet')).toBe('claude-sonnet-4-6')
  })
})

// ---------------------------------------------------------------------------
// 8. Project URI field
// ---------------------------------------------------------------------------

describe('project URI field', () => {
  it('createConversation auto-populates project from cwd', () => {
    store.createConversation('proj-1', '/Users/jonas/projects/foo')
    const conv = store.getConversation('proj-1')!
    expect(conv.project).toBe('claude://default/Users/jonas/projects/foo')
  })

  it('project uses claude:// scheme by default', () => {
    store.createConversation('proj-2', '/tmp/test')
    expect(store.getConversation('proj-2')!.project).toBe('claude://default/tmp/test')
  })

  it('clearConversation updates project from new cwd', () => {
    store.createConversation('proj-clear', '/old/path')
    store.clearConversation('proj-clear', '/new/path')
    const conv = store.getConversation('proj-clear')!
    expect(conv.id).toBe('proj-clear')
    expect(conv.project).toBe('claude://default/new/path')
  })

  it('project field survives conversation resume', () => {
    store.createConversation('proj-resume', '/Users/jonas/projects/bar')
    store.resumeConversation('proj-resume')
    const conv = store.getConversation('proj-resume')!
    expect(conv.project).toBe('claude://default/Users/jonas/projects/bar')
  })
})

// ---------------------------------------------------------------------------
// 9. Project URI-based lookups (Phase 1b)
// ---------------------------------------------------------------------------

describe('project link management (project URI)', () => {
  it('linkProjects + checkProjectLink uses project URI internally', () => {
    store.createConversation('link-a', '/projects/alpha')
    store.createConversation('link-b', '/projects/beta')
    store.linkProjects('link-a', 'link-b')

    expect(store.checkProjectLink('link-a', 'link-b')).toBe('linked')
    expect(store.checkProjectLink('link-b', 'link-a')).toBe('linked')
  })

  it('checkProjectLink returns unknown for unlinked sessions', () => {
    store.createConversation('unknown-a', '/projects/one')
    store.createConversation('unknown-b', '/projects/two')

    expect(store.checkProjectLink('unknown-a', 'unknown-b')).toBe('unknown')
  })

  it('checkProjectLink returns unknown for missing sessions', () => {
    store.createConversation('exists', '/projects/real')
    expect(store.checkProjectLink('exists', 'ghost')).toBe('unknown')
    expect(store.checkProjectLink('ghost', 'exists')).toBe('unknown')
  })

  it('blockProject marks pair as blocked', () => {
    store.createConversation('block-a', '/projects/x')
    store.createConversation('block-b', '/projects/y')

    store.linkProjects('block-a', 'block-b')
    expect(store.checkProjectLink('block-a', 'block-b')).toBe('linked')

    store.blockProject('block-a', 'block-b')
    expect(store.checkProjectLink('block-a', 'block-b')).toBe('blocked')
  })

  it('unlinkProjects removes link by conversation ID', () => {
    store.createConversation('unlink-a', '/projects/m')
    store.createConversation('unlink-b', '/projects/n')

    store.linkProjects('unlink-a', 'unlink-b')
    expect(store.checkProjectLink('unlink-a', 'unlink-b')).toBe('linked')

    store.unlinkProjects('unlink-a', 'unlink-b')
    expect(store.checkProjectLink('unlink-a', 'unlink-b')).toBe('unknown')
  })

  it('unlinkProjects by conversation ID severs project link', () => {
    store.createConversation('cwd-unlink-a', 'claude://default/projects/p')
    store.createConversation('cwd-unlink-b', 'claude://default/projects/q')

    store.linkProjects('cwd-unlink-a', 'cwd-unlink-b')
    expect(store.checkProjectLink('cwd-unlink-a', 'cwd-unlink-b')).toBe('linked')

    store.unlinkProjects('cwd-unlink-a', 'cwd-unlink-b')
    expect(store.checkProjectLink('cwd-unlink-a', 'cwd-unlink-b')).toBe('unknown')
  })

  it('getLinkedProjects returns linked project CWDs for a conversation', () => {
    store.createConversation('gp-a', '/projects/foo')
    store.createConversation('gp-b', '/projects/bar')
    store.linkProjects('gp-a', 'gp-b')

    const linked = store.getLinkedProjects('gp-a')
    expect(linked).toHaveLength(1)
    expect(linked[0].project).toBe('claude://default/projects/bar')
  })

  it('getLinkedProjects returns empty for conversation with no links', () => {
    store.createConversation('gp-solo', '/projects/solo')
    expect(store.getLinkedProjects('gp-solo')).toEqual([])
  })

  it('link key normalization: same project URI = same key', () => {
    store.createConversation('norm-a', '/projects/same')
    store.createConversation('norm-b', '/projects/other')

    store.linkProjects('norm-a', 'norm-b')
    expect(store.checkProjectLink('norm-a', 'norm-b')).toBe('linked')
    expect(store.checkProjectLink('norm-b', 'norm-a')).toBe('linked')
  })
})

describe('project message queue (project URI)', () => {
  it('queueProjectMessage + drainProjectMessages uses project URI keys', () => {
    store.createConversation('mq-a', '/projects/sender')
    store.createConversation('mq-b', '/projects/receiver')

    const msg1 = { type: 'test', content: 'hello' }
    const msg2 = { type: 'test', content: 'world' }
    store.queueProjectMessage('mq-a', 'mq-b', msg1)
    store.queueProjectMessage('mq-a', 'mq-b', msg2)

    const drained = store.drainProjectMessages('mq-a', 'mq-b')
    expect(drained).toHaveLength(2)
    expect(drained[0]).toEqual(msg1)
    expect(drained[1]).toEqual(msg2)
  })

  it('drainProjectMessages empties the queue', () => {
    store.createConversation('drain-a', '/projects/s')
    store.createConversation('drain-b', '/projects/r')

    store.queueProjectMessage('drain-a', 'drain-b', { type: 'x' })
    store.drainProjectMessages('drain-a', 'drain-b')

    const second = store.drainProjectMessages('drain-a', 'drain-b')
    expect(second).toHaveLength(0)
  })

  it('drainProjectMessages returns empty for missing sessions', () => {
    expect(store.drainProjectMessages('ghost-a', 'ghost-b')).toEqual([])
  })
})

describe('broadcast scoping (project URI)', () => {
  it('broadcastForProject accepts bare CWD (backward compat)', () => {
    store.createConversation('bc-1', '/projects/target')
    expect(() => store.broadcastForProject('/projects/target')).not.toThrow()
  })

  it('broadcastForProject accepts project URI', () => {
    store.createConversation('bc-2', '/projects/target2')
    expect(() => store.broadcastForProject('claude://default/projects/target2')).not.toThrow()
  })

  it('broadcastToConversationsAtCwd accepts bare CWD (backward compat)', () => {
    store.createConversation('bw-1', '/projects/wrap')
    const count = store.broadcastToConversationsAtCwd('/projects/wrap', { type: 'test' })
    // No agent hosts registered, so count is 0 but shouldn't throw
    expect(count).toBe(0)
  })

  it('broadcastToConversationsForProject accepts project URI', () => {
    store.createConversation('bw-2', '/projects/wrap2')
    const count = store.broadcastToConversationsForProject('claude://default/projects/wrap2', { type: 'test' })
    expect(count).toBe(0)
  })
})

describe('isEvictableDaemonGhost (dead daemon ghost cleanup)', () => {
  const NOW = 1_000_000_000
  const TTL = 15 * 60 * 1000
  const ghost = (over: Record<string, unknown> = {}) => ({
    agentHostType: 'daemon',
    status: 'ended',
    events: [] as unknown[],
    lastActivity: NOW - TTL - 1,
    ...over,
  })

  it('evicts a dead empty daemon ghost past the TTL', () => {
    expect(isEvictableDaemonGhost(ghost(), false, false, NOW, TTL)).toBe(true)
  })

  it('keeps a ghost still within the TTL', () => {
    expect(isEvictableDaemonGhost(ghost({ lastActivity: NOW - 1000 }), false, false, NOW, TTL)).toBe(false)
  })

  it('never evicts a hosted daemon conv (has boot events)', () => {
    expect(isEvictableDaemonGhost(ghost({ events: [{ type: 'boot' }] }), false, false, NOW, TTL)).toBe(false)
  })

  it('never evicts a conv that has a transcript', () => {
    expect(isEvictableDaemonGhost(ghost(), true, false, NOW, TTL)).toBe(false)
  })

  it('never evicts a conv with a live socket', () => {
    expect(isEvictableDaemonGhost(ghost(), false, true, NOW, TTL)).toBe(false)
  })

  it('never evicts a non-ended ghost', () => {
    expect(isEvictableDaemonGhost(ghost({ status: 'idle' }), false, false, NOW, TTL)).toBe(false)
  })

  it('never evicts a non-daemon conversation', () => {
    expect(isEvictableDaemonGhost(ghost({ agentHostType: 'claude' }), false, false, NOW, TTL)).toBe(false)
  })

  // 2026-05-27 incident "conv_U1hmr7d6eRpv": claudewerk-spawned daemon convs were
  // evicted because `events.length === 0` is true for ALL daemon convs (the
  // hook-addEvent path is PTY/headless only -- daemon convs accumulate
  // transcript entries, not `events`). When the worker reappeared in the
  // roster, the broker created a bare mirror row with only `{ daemonShort }` --
  // dropping launchConfig, ccSessionId, and the original title. The fix
  // requires `!agentHostMeta?.daemonMode` since `daemonMode` is written
  // exclusively by `buildDaemonLaunchMeta` in claudewerk's spawn path.
  it('never evicts a claudewerk-spawned daemon conv (agentHostMeta.daemonMode is set)', () => {
    expect(isEvictableDaemonGhost(ghost({ agentHostMeta: { daemonMode: 'new' } }), false, false, NOW, TTL)).toBe(false)
  })

  it('still evicts a bare roster-mirror ghost (agentHostMeta has only daemonShort, no daemonMode)', () => {
    expect(isEvictableDaemonGhost(ghost({ agentHostMeta: { daemonShort: 'b764469d' } }), false, false, NOW, TTL)).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// Phase B: durable sub-conversations (persist + per-scope seq + store fallback)
// ---------------------------------------------------------------------------

describe('addSubagentTranscriptEntries durability (Checkpoint B)', () => {
  function subEntry(uuid: string, text: string): TranscriptEntry {
    return { type: 'assistant', uuid, message: { role: 'assistant', content: text } } as unknown as TranscriptEntry
  }

  it('persists agent entries to the store under the agent scope, parent scope untouched', () => {
    const driver = createStore({ type: 'memory' })
    driver.init()
    const s = createConversationStore({ store: driver, enablePersistence: true })
    s.createConversation('conv-b1', '/cwd')

    s.addTranscriptEntries('conv-b1', [makeTranscriptEntry('user')], true)
    s.addSubagentTranscriptEntries('conv-b1', 'agent-x', [subEntry('sx-1', 'hello'), subEntry('sx-2', 'world')], true)

    // Agent rows land in their scope; parent scope keeps only the parent entry.
    expect(driver.transcripts.count('conv-b1', 'agent-x')).toBe(2)
    expect(driver.transcripts.count('conv-b1', null)).toBe(1)
    // Per-scope seq isolation: agent stream numbers from 1 independently.
    expect(driver.transcripts.getLatest('conv-b1', 10, 'agent-x').map(e => e.seq)).toEqual([1, 2])
    expect(driver.transcripts.getLatest('conv-b1', 10, null).map(e => e.seq)).toEqual([1])
  })

  it('only the deduped tail is persisted on incremental ingest', () => {
    const driver = createStore({ type: 'memory' })
    driver.init()
    const s = createConversationStore({ store: driver, enablePersistence: true })
    s.createConversation('conv-b2', '/cwd')

    s.addSubagentTranscriptEntries('conv-b2', 'agent-x', [subEntry('d1', 'a')], false)
    // d1 repeats (dup), d2 is fresh -- store must end with exactly d1, d2.
    s.addSubagentTranscriptEntries('conv-b2', 'agent-x', [subEntry('d1', 'a'), subEntry('d2', 'b')], false)

    expect(driver.transcripts.count('conv-b2', 'agent-x')).toBe(2)
    expect(driver.transcripts.getLatest('conv-b2', 10, 'agent-x').map(e => e.uuid)).toEqual(['d1', 'd2'])
  })

  it('loadSubagentTranscriptFromStore survives a broker restart (fresh store over same driver)', () => {
    const driver = createStore({ type: 'memory' })
    driver.init()
    const s1 = createConversationStore({ store: driver, enablePersistence: true })
    s1.createConversation('conv-b3', '/cwd')
    s1.addSubagentTranscriptEntries('conv-b3', 'agent-x', [subEntry('r1', 'durable')], true)

    // Simulate a broker restart: a brand-new conversation store over the SAME
    // driver has an empty in-memory cache, so the only path to the agent
    // sub-stream is the durable store.
    const s2 = createConversationStore({ store: driver, enablePersistence: true })
    expect(s2.hasSubagentTranscriptCache('conv-b3', 'agent-x')).toBe(false)
    const loaded = s2.loadSubagentTranscriptFromStore('conv-b3', 'agent-x', 100)
    expect(loaded?.map(e => e.uuid)).toEqual(['r1'])
    expect(loaded?.[0].seq).toBe(1)
  })

  it('skips persistence for an unregistered conversation (orphan write guard)', () => {
    const driver = createStore({ type: 'memory' })
    driver.init()
    const s = createConversationStore({ store: driver, enablePersistence: true })
    // 'ghost-b' was never createConversation'd.
    s.addSubagentTranscriptEntries('ghost-b', 'agent-x', [subEntry('g1', 'x')], true)
    expect(driver.transcripts.count('ghost-b', 'agent-x')).toBe(0)
  })
})
