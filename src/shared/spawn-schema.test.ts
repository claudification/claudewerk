import { describe, expect, it } from 'bun:test'
import { type SpawnRequest, validatedSpawnRequestSchema } from './spawn-schema'

describe('validatedSpawnRequestSchema -- legacy daemon shape removed (transport reframe Phase 6)', () => {
  it('rejects the removed backend:"daemon" enum value', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', backend: 'daemon', prompt: 'go' }).success).toBe(false)
  })

  it('surfaces "backend" in the issue path for a daemon backend (a clear enum error)', () => {
    const r = validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', backend: 'daemon' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.path.includes('backend'))).toBe(true)
    }
  })

  it('strips the removed flat daemon* fields rather than honoring them', () => {
    // A claude spawn carrying a stale flat `daemonMode` parses (zod strips the
    // unknown key) -- the daemon shape is `transport:"claude-daemon"` only.
    const r = validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', backend: 'claude', daemonMode: 'new' })
    expect(r.success).toBe(true)
    if (r.success) expect('daemonMode' in r.data).toBe(false)
  })
})

/** A minimal claude-daemon transport spawn request, overridable per-test. */
const transportDaemonReq = (
  meta: Record<string, unknown> = {},
  over: Partial<SpawnRequest> = {},
): Record<string, unknown> => ({
  cwd: '/tmp/work',
  transport: 'claude-daemon',
  transportMeta: meta,
  ...over,
})

describe('validatedSpawnRequestSchema -- transport cross-field rules (refineTransportSpawn)', () => {
  it('does not apply transport rules to a non-daemon transport (claude-pty, no prompt -> ok)', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', transport: 'claude-pty' }).success).toBe(true)
  })

  it('does not apply transport rules when no transport is set', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', backend: 'claude' }).success).toBe(true)
  })

  it('accepts claude-daemon new with a prompt', () => {
    expect(validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'new' }, { prompt: 'go' })).success).toBe(
      true,
    )
  })

  it('accepts claude-daemon new WITHOUT a prompt (promptless NEW -- Phase 4/5/7)', () => {
    expect(validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'new' })).success).toBe(true)
  })

  it('treats an absent transportMeta.mode as new (no prompt -> accept)', () => {
    expect(validatedSpawnRequestSchema.safeParse(transportDaemonReq()).success).toBe(true)
  })

  it('rejects claude-daemon resume without transportMeta.resumeSessionId', () => {
    expect(validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'resume' })).success).toBe(false)
  })

  it('accepts claude-daemon resume with resumeSessionId and no prompt', () => {
    expect(
      validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'resume', resumeSessionId: 'sess-1' })).success,
    ).toBe(true)
  })

  it('rejects claude-daemon attach without transportMeta.attachShort', () => {
    expect(validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'attach' })).success).toBe(false)
  })

  it('accepts claude-daemon attach with a valid 8-hex attachShort and no prompt', () => {
    expect(
      validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'attach', attachShort: 'aeb185f9' })).success,
    ).toBe(true)
  })

  it('rejects an attachShort that is not 8 hex chars', () => {
    expect(
      validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'attach', attachShort: 'NOTHEX!!' })).success,
    ).toBe(false)
    expect(
      validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'attach', attachShort: 'abc' })).success,
    ).toBe(false)
  })

  it('forbids config injection on attach (settingsPath / mcpConfigPath / appendSystemPrompt in transportMeta)', () => {
    for (const key of ['settingsPath', 'mcpConfigPath', 'appendSystemPrompt']) {
      const r = validatedSpawnRequestSchema.safeParse(
        transportDaemonReq({ mode: 'attach', attachShort: 'aeb185f9', [key]: '/x' }),
      )
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues.some(i => i.path.includes('transportMeta') && i.path.includes(key))).toBe(true)
      }
    }
  })

  it('surfaces the failing field in the issue path (resume -> transportMeta.resumeSessionId)', () => {
    const r = validatedSpawnRequestSchema.safeParse(transportDaemonReq({ mode: 'resume' }))
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.path.includes('transportMeta') && i.path.includes('resumeSessionId'))).toBe(
        true,
      )
    }
  })

  it('accepts the canonical daemon shape (backend:claude + transport:claude-daemon)', () => {
    const canonical = validatedSpawnRequestSchema.safeParse({
      cwd: '/tmp/work',
      backend: 'claude',
      prompt: 'go',
      transport: 'claude-daemon',
      transportMeta: { mode: 'new' },
    })
    expect(canonical.success).toBe(true)
  })

  it('promotes settingsPath / mcpConfigPath to top-level (accepted on a claude spawn)', () => {
    const r = validatedSpawnRequestSchema.safeParse({
      cwd: '/tmp',
      backend: 'claude',
      settingsPath: '/abs/settings.json',
      mcpConfigPath: '/abs/mcp.json',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.settingsPath).toBe('/abs/settings.json')
      expect(r.data.mcpConfigPath).toBe('/abs/mcp.json')
    }
  })
})

describe('validatedSpawnRequestSchema -- sentinel profile / pool fields (Phase 9 audit)', () => {
  it('accepts a literal profile name (Fixed selection)', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', profile: 'work' }).success).toBe(true)
  })

  it('accepts SelectionMode tokens as profile values', () => {
    for (const token of ['default', 'balanced', 'random']) {
      expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', profile: token }).success).toBe(true)
    }
  })

  it('accepts a pool name', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', pool: 'work' }).success).toBe(true)
  })

  it('accepts profile + pool together (broker resolves precedence: profile wins)', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', profile: 'work', pool: 'default' }).success).toBe(true)
  })

  it('treats both profile and pool as optional (omitting both is valid)', () => {
    const r = validatedSpawnRequestSchema.safeParse({ cwd: '/tmp' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.profile).toBeUndefined()
      expect(r.data.pool).toBeUndefined()
    }
  })

  it('rejects an empty profile string (min length 1)', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', profile: '' }).success).toBe(false)
  })

  it('rejects an over-long profile name (max length 63)', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', profile: 'a'.repeat(64) }).success).toBe(false)
  })

  it('rejects a pool name with characters outside [a-z0-9-]', () => {
    for (const bad of ['Work', 'work_pool', 'work pool', 'work!']) {
      expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', pool: bad }).success).toBe(false)
    }
  })

  it('rejects an empty pool string', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', pool: '' }).success).toBe(false)
  })

  it('rejects an over-long pool name (max length 63)', () => {
    expect(validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', pool: 'a'.repeat(64) }).success).toBe(false)
  })

  it('surfaces "pool" in the issue path for a malformed pool', () => {
    const r = validatedSpawnRequestSchema.safeParse({ cwd: '/tmp', pool: 'Bad Pool' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.path.includes('pool'))).toBe(true)
    }
  })
})
