import { describe, expect, it } from 'vitest'
import { _buildDaemonSpawnRequest, _buildStandardSpawnRequest, type SpawnActionContext } from './use-spawn-action'

function makeCtx(overrides: Partial<SpawnActionContext> = {}): SpawnActionContext {
  return {
    state: { open: true, options: { path: '/cwd', mkdir: false } },
    phase: 'config',
    effectivePath: '/cwd',
    name: '',
    description: '',
    sentinelProfile: '',
    sentinelPool: '',
    headless: true,
    bare: false,
    repl: false,
    model: '',
    effort: '',
    agent: '',
    permissionMode: '',
    autocompactPct: '' as number | '',
    maxBudgetUsd: '',
    resumeId: '',
    includePartialMessages: true,
    useWorktree: false,
    worktreeName: '',
    envText: '',
    backend: 'claude',
    transport: 'claude-pty',
    isDaemonTransport: false,
    chatConnectionId: '',
    chatConnections: [],
    openCodeModel: '',
    openCodeToolPermission: 'safe',
    hermesGatewayId: '',
    daemonMode: 'new',
    daemonForm: { agent: '', model: '', effort: '', permissionMode: '', resumeShort: '', workerCwd: '' } as never,
    daemonAttach: null,
    progress: {} as never,
    setPhase: () => undefined,
    setJobId: () => undefined,
    setWrapperId: () => undefined,
    setDaemonErrors: () => undefined,
    setConfigTab: () => undefined,
    conversationAtSpawnRef: { current: null },
    ...overrides,
  }
}

describe('buildStandardSpawnRequest', () => {
  it('builds a minimal claude PTY request with default values', () => {
    const built = _buildStandardSpawnRequest(makeCtx(), 'job-1')
    if ('envError' in built) throw new Error('unexpected envError')
    expect(built.req.cwd).toBe('/cwd')
    expect(built.req.headless).toBe(true)
    expect(built.req.jobId).toBe('job-1')
    expect(built.req.transport).toBe('claude-pty')
    expect(built.req.backend).toBeUndefined() // default claude omits the backend field
  })

  it('passes resumeId and switches to resume mode when set', () => {
    const built = _buildStandardSpawnRequest(makeCtx({ resumeId: '  abc123  ' }), 'job-2')
    if ('envError' in built) throw new Error('unexpected envError')
    expect(built.req.mode).toBe('resume')
    expect(built.req.resumeId).toBe('abc123')
  })

  it('flags an env error when envText is malformed', () => {
    const built = _buildStandardSpawnRequest(makeCtx({ envText: 'NOT_VALID_KV' }), 'job-3')
    expect('envError' in built).toBe(true)
  })

  it('sets backend + chat fields when backend is chat-api', () => {
    const built = _buildStandardSpawnRequest(
      makeCtx({ backend: 'chat-api', chatConnectionId: 'cid-1', chatConnections: [{ id: 'cid-1', name: 'My API' } as never] }),
      'job-4',
    )
    if ('envError' in built) throw new Error('unexpected envError')
    expect(built.req.backend).toBe('chat-api')
    expect(built.req.chatConnectionId).toBe('cid-1')
    expect(built.req.chatConnectionName).toBe('My API')
  })

  it('sets backend + openCode fields when backend is opencode', () => {
    const built = _buildStandardSpawnRequest(
      makeCtx({ backend: 'opencode', openCodeModel: '  openrouter/anthropic/claude  ', openCodeToolPermission: 'full' }),
      'job-5',
    )
    if ('envError' in built) throw new Error('unexpected envError')
    expect(built.req.backend).toBe('opencode')
    expect(built.req.openCodeModel).toBe('openrouter/anthropic/claude')
    expect(built.req.toolPermission).toBe('full')
  })
})

describe('buildDaemonSpawnRequest', () => {
  it('returns validation errors when ATTACH has no roster pick', () => {
    const built = _buildDaemonSpawnRequest(makeCtx({ daemonMode: 'attach', daemonAttach: null }), 'job-d-1')
    expect('errors' in built).toBe(true)
  })
})
