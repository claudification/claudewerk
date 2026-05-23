import { describe, expect, it } from 'bun:test'
import type { LaunchConfig } from '../../shared/protocol'
import type { SpawnRequest } from '../../shared/spawn-schema'
import {
  buildDaemonLaunchConfig,
  buildDaemonLaunchMeta,
  buildSentinelSpawnMessage,
  DAEMON_META,
  type DaemonConfig,
  dispatchClaudeDaemon,
  findDaemonConversationByShort,
  readDaemonConfig,
  validateDaemonModeFields,
} from './claude-daemon'
import type { SpawnDeps } from './types'

/** A minimal claude-daemon SpawnRequest, overridable per-test. The daemon launch
 *  inputs ride in transportMeta -- there are no flat daemon* fields anymore. */
const req = (meta: Record<string, unknown> = {}, over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  cwd: '/tmp/work',
  backend: 'claude',
  transport: 'claude-daemon',
  transportMeta: meta,
  ...over,
})

/** Build a DaemonConfig directly for the pure helpers under test. */
const cfg = (over: Partial<DaemonConfig> = {}): DaemonConfig => ({ mode: 'new', ...over })

describe('readDaemonConfig', () => {
  it('reads the daemon launch inputs from transportMeta', () => {
    const c = readDaemonConfig(
      req({ mode: 'resume', resumeSessionId: 'sess-1', settingsPath: '/s.json', mcpConfigPath: '/m.json' }),
    )
    expect(c.mode).toBe('resume')
    expect(c.resumeSessionId).toBe('sess-1')
    expect(c.settingsPath).toBe('/s.json')
    expect(c.mcpConfigPath).toBe('/m.json')
  })

  it('defaults the mode to new and falls back to promoted top-level settings/mcp paths', () => {
    const c = readDaemonConfig(req({}, { settingsPath: '/top-s.json', mcpConfigPath: '/top-m.json' }))
    expect(c.mode).toBe('new')
    expect(c.settingsPath).toBe('/top-s.json')
    expect(c.mcpConfigPath).toBe('/top-m.json')
  })

  it('prefers transportMeta over the promoted top-level paths', () => {
    const c = readDaemonConfig(req({ settingsPath: '/meta-s.json' }, { settingsPath: '/top-s.json' }))
    expect(c.settingsPath).toBe('/meta-s.json')
  })
})

describe('validateDaemonModeFields', () => {
  it('new mode requires a prompt', () => {
    expect(validateDaemonModeFields(req(), cfg({ mode: 'new' }))).toMatch(/new mode/)
    expect(validateDaemonModeFields(req({}, { prompt: 'go' }), cfg({ mode: 'new' }))).toBeNull()
  })

  it('resume mode requires transportMeta.resumeSessionId (prompt optional)', () => {
    expect(validateDaemonModeFields(req(), cfg({ mode: 'resume' }))).toMatch(/resume mode/)
    expect(validateDaemonModeFields(req(), cfg({ mode: 'resume', resumeSessionId: 'sess-1' }))).toBeNull()
  })

  it('attach mode requires transportMeta.attachShort (prompt optional)', () => {
    expect(validateDaemonModeFields(req(), cfg({ mode: 'attach' }))).toMatch(/attach mode/)
    expect(validateDaemonModeFields(req(), cfg({ mode: 'attach', attachShort: 'aeb185f9' }))).toBeNull()
  })
})

describe('buildSentinelSpawnMessage', () => {
  const common = { requestId: 'r1', conversationId: 'conv_1', jobId: 'job_1', conversationName: 'Test' }

  it('NEW: carries the prompt + a normalized transportMeta config, no flat daemon* fields', () => {
    const msg = buildSentinelSpawnMessage({
      ...common,
      cfg: cfg({ mode: 'new', settingsPath: '/s.json', mcpConfigPath: '/m.json', appendSystemPrompt: 'SP' }),
      req: req({}, { prompt: 'go', model: 'm' }),
    })
    expect(msg.type).toBe('spawn')
    expect(msg.agentHostType).toBe('daemon')
    expect(msg.transport).toBe('claude-daemon')
    expect(msg.prompt).toBe('go')
    const tm = msg.transportMeta as Record<string, unknown>
    expect(tm.mode).toBe('new')
    expect(tm.settingsPath).toBe('/s.json')
    expect(tm.mcpConfigPath).toBe('/m.json')
    expect(tm.appendSystemPrompt).toBe('SP')
    // No flat daemon* fields ride the spawn message anymore.
    expect(msg.daemonMode).toBeUndefined()
    expect(msg.daemonSettingsPath).toBeUndefined()
  })

  it('RESUME: carries resumeSessionId in transportMeta, no attach field', () => {
    const msg = buildSentinelSpawnMessage({
      ...common,
      cfg: cfg({ mode: 'resume', resumeSessionId: 'sess-1' }),
      req: req({ mode: 'resume', resumeSessionId: 'sess-1' }),
    })
    const tm = msg.transportMeta as Record<string, unknown>
    expect(tm.mode).toBe('resume')
    expect(tm.resumeSessionId).toBe('sess-1')
    expect(tm.attachShort).toBeUndefined()
  })

  it('ATTACH: carries only attachShort -- no prompt, no config injection', () => {
    const msg = buildSentinelSpawnMessage({
      ...common,
      cfg: cfg({ mode: 'attach', attachShort: 'aeb185f9', settingsPath: '/s.json' }),
      req: req({}, { prompt: 'ignored' }),
    })
    const tm = msg.transportMeta as Record<string, unknown>
    expect(tm.mode).toBe('attach')
    expect(tm.attachShort).toBe('aeb185f9')
    expect(tm.settingsPath).toBeUndefined()
    expect(msg.prompt).toBeUndefined()
  })
})

describe('buildDaemonLaunchMeta', () => {
  it('NEW: persists backend, mode and the config keys', () => {
    const meta = buildDaemonLaunchMeta(
      cfg({ mode: 'new', settingsPath: '/s.json', mcpConfigPath: '/m.json', appendSystemPrompt: 'SP' }),
      undefined,
    )
    expect(meta[DAEMON_META.backend]).toBe('daemon')
    expect(meta[DAEMON_META.mode]).toBe('new')
    expect(meta[DAEMON_META.settings]).toBe('/s.json')
    expect(meta[DAEMON_META.mcp]).toBe('/m.json')
    expect(meta[DAEMON_META.appendPrompt]).toBe('SP')
  })

  it('RESUME: persists the resume session id', () => {
    const meta = buildDaemonLaunchMeta(cfg({ mode: 'resume', resumeSessionId: 'sess-1' }), undefined)
    expect(meta[DAEMON_META.mode]).toBe('resume')
    expect(meta[DAEMON_META.resume]).toBe('sess-1')
  })

  it('ATTACH: injects no config even when the cfg carries it', () => {
    const meta = buildDaemonLaunchMeta(
      cfg({ mode: 'attach', settingsPath: '/s.json', appendSystemPrompt: 'SP' }),
      undefined,
    )
    expect(meta[DAEMON_META.mode]).toBe('attach')
    expect(meta[DAEMON_META.settings]).toBeUndefined()
    expect(meta[DAEMON_META.appendPrompt]).toBeUndefined()
  })

  it('merges over existing meta without dropping foreign keys', () => {
    const meta = buildDaemonLaunchMeta(cfg({ mode: 'new' }), { priorKey: 'kept', custom: 1 })
    expect(meta.priorKey).toBe('kept')
    expect(meta.custom).toBe(1)
    expect(meta[DAEMON_META.backend]).toBe('daemon')
  })
})

describe('buildDaemonLaunchConfig', () => {
  it('NEW: records mode + injected config as a daemon LaunchConfig', () => {
    const config = buildDaemonLaunchConfig(
      req({}, { model: 'claude-haiku-4-5', env: { FOO: 'bar' } }),
      cfg({ mode: 'new', settingsPath: '/s.json', mcpConfigPath: '/m.json', appendSystemPrompt: 'SP' }),
    )
    expect(config.agentHostType).toBe('daemon')
    expect(config.headless).toBe(false)
    expect(config.transport).toBe('claude-daemon')
    expect(config.daemonMode).toBe('new')
    expect(config.model).toBe('claude-haiku-4-5')
    expect(config.daemonSettingsPath).toBe('/s.json')
    expect(config.daemonMcpConfigPath).toBe('/m.json')
    expect(config.appendSystemPrompt).toBe('SP')
    expect(config.env).toEqual({ FOO: 'bar' })
  })

  it('RESUME: records the config but never the fork-from session id', () => {
    const config = buildDaemonLaunchConfig(
      req(),
      cfg({ mode: 'resume', resumeSessionId: 'ccs_fork', settingsPath: '/s.json' }),
    )
    expect(config.daemonMode).toBe('resume')
    expect(config.daemonSettingsPath).toBe('/s.json')
    expect((config as unknown as Record<string, unknown>).daemonResumeSessionId).toBeUndefined()
  })

  it('ATTACH: records only the mode -- the worker was already configured', () => {
    const config = buildDaemonLaunchConfig(
      req(),
      cfg({ mode: 'attach', attachShort: 'aeb185f9', settingsPath: '/s.json' }),
    )
    expect(config.daemonMode).toBe('attach')
    expect(config.daemonSettingsPath).toBeUndefined()
    expect(config.appendSystemPrompt).toBeUndefined()
    expect(config.env).toBeUndefined()
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

// ─── Integration: dispatchClaudeDaemon against a fake conversation store ─────

interface FakeConv {
  id: string
  project: string
  status: string
  agentHostType?: string
  transport?: string
  agentHostMeta?: Record<string, unknown>
  launchConfig?: LaunchConfig
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

describe('dispatchClaudeDaemon -- mode validation', () => {
  it('rejects NEW without a prompt (400)', async () => {
    const { deps } = makeFakeDeps()
    const r = await dispatchClaudeDaemon(req({ mode: 'new' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.statusCode).toBe(400)
  })

  it('rejects RESUME without resumeSessionId (400)', async () => {
    const { deps } = makeFakeDeps()
    const r = await dispatchClaudeDaemon(req({ mode: 'resume' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.statusCode).toBe(400)
  })

  it('rejects ATTACH without attachShort (400)', async () => {
    const { deps } = makeFakeDeps()
    const r = await dispatchClaudeDaemon(req({ mode: 'attach' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.statusCode).toBe(400)
  })
})

describe('dispatchClaudeDaemon -- NEW mode', () => {
  it('dispatches a new-mode spawn to the sentinel and tags the conversation', async () => {
    const { deps, conversations, sent } = makeFakeDeps()
    const r = await dispatchClaudeDaemon(req({ mode: 'new', settingsPath: '/s.json' }, { prompt: 'go' }), deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(sent).toHaveLength(1)
    // Non-null assertions (not `?.`) keep this assertion block branch-free --
    // the fake store guarantees the shapes, and `?.` inflates cyclomatic.
    const msg = sent[0]!
    expect(msg.type).toBe('spawn')
    expect(msg.agentHostType).toBe('daemon')
    expect(msg.transport).toBe('claude-daemon')
    expect((msg.transportMeta as Record<string, unknown>).mode).toBe('new')
    expect(msg.prompt).toBe('go')
    const conv = conversations.get(r.conversationId)!
    expect(conv.agentHostType).toBe('daemon')
    expect(conv.transport).toBe('claude-daemon')
    expect(conv.agentHostMeta![DAEMON_META.mode]).toBe('new')
    expect(conv.agentHostMeta![DAEMON_META.settings]).toBe('/s.json')
    expect(conv.launchConfig!.agentHostType).toBe('daemon')
    expect(conv.launchConfig!.daemonMode).toBe('new')
    expect(conv.launchConfig!.daemonSettingsPath).toBe('/s.json')
  })

  it('returns a failure when the sentinel reports spawn failure', async () => {
    const { deps } = makeFakeDeps({ sentinelResult: { type: 'spawn_result', success: false, error: 'boom' } })
    const r = await dispatchClaudeDaemon(req({ mode: 'new' }, { prompt: 'go' }), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('boom')
  })
})

describe('dispatchClaudeDaemon -- ATTACH reuses the roster conversation', () => {
  it('reuses the mirrored conversationId instead of minting a new one', async () => {
    const mirror: FakeConv = {
      id: 'conv_roster',
      project: 'claude://daemon/tmp/work',
      status: 'idle',
      agentHostType: 'daemon',
      agentHostMeta: { [DAEMON_META.short]: 'aeb185f9' },
    }
    const { deps, sent, conversations } = makeFakeDeps({ seed: [mirror] })
    const r = await dispatchClaudeDaemon(req({ mode: 'attach', attachShort: 'aeb185f9' }), deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.conversationId).toBe('conv_roster')
    const tm = sent[0]!.transportMeta as Record<string, unknown>
    expect(tm.mode).toBe('attach')
    expect(tm.attachShort).toBe('aeb185f9')
    expect(sent[0]!.prompt).toBeUndefined()
    expect(conversations.get('conv_roster')!.agentHostMeta![DAEMON_META.short]).toBe('aeb185f9')
  })

  it('mints a fresh conversationId when the roster has no matching short', async () => {
    const { deps } = makeFakeDeps()
    const r = await dispatchClaudeDaemon(req({ mode: 'attach', attachShort: 'deadbeef' }), deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.conversationId.length).toBeGreaterThan(0)
  })
})
