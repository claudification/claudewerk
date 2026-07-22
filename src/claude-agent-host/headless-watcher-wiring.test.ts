/**
 * Guards the one link the seam tests cannot see: that a headless boot actually
 * STARTS the JSONL watcher, on the right path.
 *
 * Everything downstream (the predicate, the seek-to-end read, the queued badge)
 * is dead weight if `onInit` never calls startTranscriptWatcher -- and a missing
 * call fails silently, with a working transcript and no badge, which is exactly
 * the bug being fixed.
 */

import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { AgentHostContext } from './agent-host-context'
import { buildHeadlessSpawnOptions, type HeadlessCallbackDeps } from './headless-lifecycle'
import type { StreamBackendOptions, StreamProcess } from './stream-backend'

function makeDeps(ctx: AgentHostContext): HeadlessCallbackDeps {
  return {
    ctx,
    permissionRules: { shouldAutoApprove: () => false, isPlanModeAllowed: () => true },
    finalClaudeArgs: [],
    settingsPath: '/tmp/settings.json',
    localServerPort: 0,
    rclaudeDir: '/tmp',
    mcpConfigPath: '/tmp/mcp.json',
    spawnStreamClaude: (() => ({}) as StreamProcess) as (o: StreamBackendOptions) => StreamProcess,
    cleanup: () => {},
  }
}

function makeCtx(started: string[], resumeId?: string): AgentHostContext {
  return {
    headless: true,
    cwd: '/Users/jonas/projects/demo',
    conversationId: 'conv_test',
    claudeSessionId: null,
    parentTranscriptPath: '',
    resumeId,
    transcriptWatcher: null,
    subagentWatchers: new Map(),
    pendingTranscriptEntries: [],
    syntheticUserUuids: new Map(),
    launchEvents: [],
    diag: () => {},
    debug: () => {},
    startTranscriptWatcher: (path: string) => started.push(path),
    // The init path fans out into session-transition / launch-events / broker
    // pushes. None of that is under test here, so absorb every wsClient call
    // rather than chasing each method as it is added.
    wsClient: new Proxy(
      { isConnected: () => false },
      { get: (target, prop) => Reflect.get(target, prop) ?? (() => {}) },
    ),
    connectToBroker: () => {},
  } as unknown as AgentHostContext
}

const init = (sessionId: string) =>
  ({ type: 'system', subtype: 'init', session_id: sessionId, model: 'haiku' }) as unknown as Parameters<
    NonNullable<StreamBackendOptions['onInit']>
  >[0]

describe('headless boot wiring', () => {
  it('starts the transcript watcher on the derived JSONL path', () => {
    const started: string[] = []
    const ctx = makeCtx(started)

    buildHeadlessSpawnOptions(makeDeps(ctx)).onInit?.(init('abc12345-0000-0000-0000-000000000000'))

    expect(ctx.parentTranscriptPath).toContain('abc12345-0000-0000-0000-000000000000.jsonl')
    expect(started).toEqual([ctx.parentTranscriptPath ?? ''])
  })

  it('uses the resumeId path, not the fresh session_id, on --resume', () => {
    // On --resume CC reports a NEW session_id but keeps writing to the ORIGINAL
    // file. Watching the session_id path would tail a file that never exists.
    const started: string[] = []
    const ctx = makeCtx(started, 'original-session-id')

    buildHeadlessSpawnOptions(makeDeps(ctx)).onInit?.(init('brand-new-session-id'))

    expect(ctx.parentTranscriptPath).toContain('original-session-id.jsonl')
    expect(ctx.parentTranscriptPath).not.toContain('brand-new-session-id')
    expect(started).toEqual([ctx.parentTranscriptPath ?? ''])
  })

  it('STILL starts the watcher when the SessionStart hook already set the path', () => {
    // The regression that shipped in f4f67ad: the start call sat inside the
    // `!ctx.parentTranscriptPath` derivation branch, and in any hooked spawn
    // the SessionStart hook sets that path first -- so the branch was skipped
    // and the watcher never started. Silent: transcript fine, badge missing.
    // Caught only by a live spawn, never by a unit test, because the earlier
    // version of this test asserted the skip was correct.
    const started: string[] = []
    const ctx = makeCtx(started)
    ctx.parentTranscriptPath = join('/already', 'known.jsonl')

    buildHeadlessSpawnOptions(makeDeps(ctx)).onInit?.(init('abc12345-0000-0000-0000-000000000000'))

    // Path is left alone (the hook's value wins) but the watcher DOES start.
    expect(ctx.parentTranscriptPath).toBe(join('/already', 'known.jsonl'))
    expect(started).toEqual([join('/already', 'known.jsonl')])
  })
})
