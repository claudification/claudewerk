import { describe, expect, it } from 'bun:test'
import type { SpawnRequest } from '../../shared/spawn-schema'
import {
  buildDaemonLaunchMeta,
  buildSentinelSpawnMessage,
  DAEMON_META,
  daemonBackend,
  findDaemonConversationByShort,
  validateDaemonModeFields,
} from './daemon'
import type { SpawnDeps } from './types'

/** A minimal daemon SpawnRequest, overridable per-test. */
const req = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({ cwd: '/tmp/work', backend: 'daemon', ...over })

describe('validateDaemonModeFields', () => {
  it('new mode requires a prompt', () => {
    expect(validateDaemonModeFields(req(), 'new')).toMatch(/new mode/)
    expect(validateDaemonModeFields(req({ prompt: 'go' }), 'new')).toBeNull()
  })

  it('resume mode requires daemonResumeSessionId (prompt optional)', () => {
    expect(validateDaemonModeFields(req(), 'resume')).toMatch(/resume mode/)
    expect(validateDaemonModeFields(req({ daemonResumeSessionId: 'sess-1' }), 'resume')).toBeNull()
  })

  it('attach mode requires daemonAttachShort (prompt optional)', () => {
    expect(validateDaemonModeFields(req(), 'attach')).toMatch(/attach mode/)
    expect(validateDaemonModeFields(req({ daemonAttachShort: 'aeb185f9' }), 'attach')).toBeNull()
  })
})

describe('buildSentinelSpawnMessage', () => {
  const common = { requestId: 'r1', conversationId: 'conv_1', jobId: 'job_1', conversationName: 'Test' }

  it('NEW: carries the prompt + config flags, no attach/resume fields', () => {
    const msg = buildSentinelSpawnMessage({
      ...common,
      daemonMode: 'new',
      req: req({
        prompt: 'go',
        model: 'm',
        daemonSettingsPath: '/s.json',
        daemonMcpConfigPath: '/m.json',
        appendSystemPrompt: 'SP',
      }),
    })
    expect(msg.type).toBe('spawn')
    expect(msg.agentHostType).toBe('daemon')
    expect(msg.daemonMode).toBe('new')
    expect(msg.prompt).toBe('go')
    expect(msg.daemonSettingsPath).toBe('/s.json')
    expect(msg.daemonMcpConfigPath).toBe('/m.json')
    expect(msg.appendSystemPrompt).toBe('SP')
    expect(msg.daemonAttachShort).toBeUndefined()
    expect(msg.daemonResumeSessionId).toBeUndefined()
  })

  it('RESUME: carries daemonResumeSessionId, no attach field', () => {
    const msg = buildSentinelSpawnMessage({
      ...common,
      daemonMode: 'resume',
      req: req({ daemonResumeSessionId: 'sess-1' }),
    })
    expect(msg.daemonMode).toBe('resume')
    expect(msg.daemonResumeSessionId).toBe('sess-1')
    expect(msg.daemonAttachShort).toBeUndefined()
  })

  it('ATTACH: carries only daemonAttachShort -- no prompt, no config injection', () => {
    const msg = buildSentinelSpawnMessage({
      ...common,
      daemonMode: 'attach',
      req: req({ daemonAttachShort: 'aeb185f9', prompt: 'ignored', daemonSettingsPath: '/s.json' }),
    })
    expect(msg.daemonMode).toBe('attach')
    expect(msg.daemonAttachShort).toBe('aeb185f9')
    expect(msg.prompt).toBeUndefined()
    expect(msg.daemonSettingsPath).toBeUndefined()
  })
})

describe('buildDaemonLaunchMeta', () => {
  it('NEW: persists backend, mode and the config keys', () => {
    const meta = buildDaemonLaunchMeta(
      req({ daemonSettingsPath: '/s.json', daemonMcpConfigPath: '/m.json', appendSystemPrompt: 'SP' }),
      'new',
      undefined,
    )
    expect(meta[DAEMON_META.backend]).toBe('daemon')
    expect(meta[DAEMON_META.mode]).toBe('new')
    expect(meta[DAEMON_META.settings]).toBe('/s.json')
    expect(meta[DAEMON_META.mcp]).toBe('/m.json')
    expect(meta[DAEMON_META.appendPrompt]).toBe('SP')
  })

  it('RESUME: persists the resume session id', () => {
    const meta = buildDaemonLaunchMeta(req({ daemonResumeSessionId: 'sess-1' }), 'resume', undefined)
    expect(meta[DAEMON_META.mode]).toBe('resume')
    expect(meta[DAEMON_META.resume]).toBe('sess-1')
  })

  it('ATTACH: injects no config even when the request carries it', () => {
    const meta = buildDaemonLaunchMeta(
      req({ daemonSettingsPath: '/s.json', appendSystemPrompt: 'SP' }),
      'attach',
      undefined,
    )
    expect(meta[DAEMON_META.mode]).toBe('attach')
    expect(meta[DAEMON_META.settings]).toBeUndefined()
    expect(meta[DAEMON_META.appendPrompt]).toBeUndefined()
  })

  it('merges over existing meta without dropping foreign keys', () => {
    // The daemon-agent-host boot path adds more keys later -- the merge must
    // not clobber whatever the opaque bag already holds.
    const meta = buildDaemonLaunchMeta(req({ prompt: 'go' }), 'new', { priorKey: 'kept', custom: 1 })
    expect(meta.priorKey).toBe('kept')
    expect(meta.custom).toBe(1)
    expect(meta[DAEMON_META.backend]).toBe('daemon')
  })
})

describe('findDaemonConversationByShort', () => {
  const depsWith = (convs: unknown[]): SpawnDeps =>
    ({ conversationStore: { getAllConversations: () => convs } }) as unknown as SpawnDeps

  it('finds the daemon conversation whose mirror stored the short', () => {
    const target = { id: 'conv_target', agentHostType: 'daemon', agentHostMeta: { [DAEMON_META.short]: 'aeb185f9' } }
    const found = findDaemonConversationByShort(
      depsWith([{ id: 'other', agentHostType: 'claude' }, target]),
      'aeb185f9',
    )
    expect(found?.id).toBe('conv_target')
  })

  it('returns undefined when no daemon conversation carries the short', () => {
    expect(findDaemonConversationByShort(depsWith([{ id: 'x', agentHostType: 'claude' }]), 'aeb185f9')).toBeUndefined()
  })

  it('ignores a non-daemon conversation that happens to carry the short', () => {
    const conv = { id: 'c', agentHostType: 'claude', agentHostMeta: { [DAEMON_META.short]: 'aeb185f9' } }
    expect(findDaemonConversationByShort(depsWith([conv]), 'aeb185f9')).toBeUndefined()
  })
})

// ─── Integration: daemonBackend.spawn against a fake conversation store ─────

interface FakeConv {
  id: string
  project: string
  status: string
  agentHostType?: string
  agentHostMeta?: Record<string, unknown>
  title?: string
  description?: string
  endedBy?: unknown
}

/** A compact fake SpawnDeps -- the sentinel resolves the spawn listener on send. */
function makeFakeDeps(opts: { sentinelResult?: Record<string, unknown>; seed?: FakeConv[] } = {}) {
  const sentinelResult = opts.sentinelResult ?? { type: 'spawn_result', success: true }
  const conversations = new Map<string, FakeConv>()
  for (const c of opts.seed ?? []) conversations.set(c.id, c)
  const listeners = new Map<string, (r: unknown) => void>()
  const sent: Array<Record<string, unknown>> = []

  const sentinel = {
    send(json: string) {
      sent.push(JSON.parse(json) as Record<string, unknown>)
      // Resolve the pending spawn listener async, like a real sentinel reply.
      queueMicrotask(() => {
        for (const cb of listeners.values()) cb(sentinelResult)
      })
    },
  }

  const conversationStore = {
    getSentinel: () => sentinel,
    getSentinelByAlias: () => sentinel,
    getConnectedSentinels: () => [{ alias: 'default', sentinelId: 'snt_test' }],
    getDefaultSentinelId: () => 'snt_test',
    isSentinelAlive: () => true,
    getAllConversations: () => [...conversations.values()],
    getConversation: (id: string) => conversations.get(id),
    createConversation: (id: string, project: string) => {
      const conv: FakeConv = { id, project, status: 'starting' }
      conversations.set(id, conv)
      return conv
    },
    createJob: () => {},
    failJob: () => {},
    recordJobConfig: () => {},
    forwardJobEvent: () => {},
    addSpawnListener: (reqId: string, cb: (r: unknown) => void) => listeners.set(reqId, cb),
    removeSpawnListener: (reqId: string) => listeners.delete(reqId),
    persistConversationById: () => {},
  }

  return { deps: { conversationStore } as unknown as SpawnDeps, conversations, sent }
}

describe('daemonBackend.spawn -- mode validation', () => {
  it('rejects NEW without a prompt (400)', async () => {
    const { deps } = makeFakeDeps()
    const r = await daemonBackend.spawn!(req({ daemonMode: 'new' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.statusCode).toBe(400)
  })

  it('rejects RESUME without daemonResumeSessionId (400)', async () => {
    const { deps } = makeFakeDeps()
    const r = await daemonBackend.spawn!(req({ daemonMode: 'resume' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.statusCode).toBe(400)
  })

  it('rejects ATTACH without daemonAttachShort (400)', async () => {
    const { deps } = makeFakeDeps()
    const r = await daemonBackend.spawn!(req({ daemonMode: 'attach' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.statusCode).toBe(400)
  })
})

describe('daemonBackend.spawn -- NEW mode', () => {
  it('dispatches a new-mode spawn to the sentinel and tags the conversation', async () => {
    const { deps, conversations, sent } = makeFakeDeps()
    const r = await daemonBackend.spawn!(req({ daemonMode: 'new', prompt: 'go', daemonSettingsPath: '/s.json' }), deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe('spawn')
    expect(sent[0]?.agentHostType).toBe('daemon')
    expect(sent[0]?.daemonMode).toBe('new')
    expect(sent[0]?.prompt).toBe('go')
    const conv = conversations.get(r.conversationId)
    expect(conv?.agentHostType).toBe('daemon')
    expect(conv?.agentHostMeta?.[DAEMON_META.mode]).toBe('new')
    expect(conv?.agentHostMeta?.[DAEMON_META.settings]).toBe('/s.json')
  })

  it('returns a failure when the sentinel reports spawn failure', async () => {
    const { deps } = makeFakeDeps({ sentinelResult: { type: 'spawn_result', success: false, error: 'boom' } })
    const r = await daemonBackend.spawn!(req({ daemonMode: 'new', prompt: 'go' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('boom')
  })
})

describe('daemonBackend.spawn -- ATTACH reuses the roster conversation', () => {
  it('reuses the mirrored conversationId instead of minting a new one', async () => {
    const mirror: FakeConv = {
      id: 'conv_roster',
      project: 'claude://daemon/tmp/work',
      status: 'idle',
      agentHostType: 'daemon',
      agentHostMeta: { [DAEMON_META.short]: 'aeb185f9' },
    }
    const { deps, sent, conversations } = makeFakeDeps({ seed: [mirror] })
    const r = await daemonBackend.spawn!(req({ daemonMode: 'attach', daemonAttachShort: 'aeb185f9' }), deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.conversationId).toBe('conv_roster')
    expect(sent[0]?.daemonMode).toBe('attach')
    expect(sent[0]?.daemonAttachShort).toBe('aeb185f9')
    expect(sent[0]?.prompt).toBeUndefined()
    // The mirror's short survives the launch-meta merge.
    expect(conversations.get('conv_roster')?.agentHostMeta?.[DAEMON_META.short]).toBe('aeb185f9')
  })

  it('mints a fresh conversationId when the roster has no matching short', async () => {
    const { deps } = makeFakeDeps()
    const r = await daemonBackend.spawn!(req({ daemonMode: 'attach', daemonAttachShort: 'deadbeef' }), deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.conversationId.length).toBeGreaterThan(0)
  })
})
