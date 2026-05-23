/**
 * Transport-reframe resolution fixtures (Phase 1 acceptance).
 *
 * Proves the central Phase 1 guarantee: a daemon spawn made via the NEW shape
 * (`transport: 'claude-daemon'` + `transportMeta`) resolves IDENTICALLY to the
 * same spawn via the LEGACY shape (`backend: 'daemon'` + flat `daemon*` fields).
 *
 * "Resolves" = the broker daemon backend's dual-read collapse point
 * (`normalizeDaemonReq` in src/broker/backends/daemon.ts), which both shapes
 * funnel through before the rest of the backend reads the flat fields. The
 * table also asserts both shapes pass `validatedSpawnRequestSchema`.
 */

import { describe, expect, it } from 'bun:test'
import { normalizeDaemonReq } from '../broker/backends/daemon'
import { type SpawnRequest, validatedSpawnRequestSchema } from './spawn-schema'

/** The daemon launch inputs the backend reads after normalization. */
const effectiveDaemonFields = (req: SpawnRequest) => ({
  daemonMode: req.daemonMode,
  daemonResumeSessionId: req.daemonResumeSessionId,
  daemonAttachShort: req.daemonAttachShort,
  daemonSettingsPath: req.daemonSettingsPath,
  daemonMcpConfigPath: req.daemonMcpConfigPath,
  appendSystemPrompt: req.appendSystemPrompt,
})

interface Fixture {
  name: string
  legacy: SpawnRequest
  fresh: SpawnRequest
  expected: ReturnType<typeof effectiveDaemonFields>
}

const cwd = '/tmp/work'

const fixtures: Fixture[] = [
  {
    name: 'NEW with full config injection',
    legacy: {
      cwd,
      backend: 'daemon',
      daemonMode: 'new',
      prompt: 'build it',
      daemonSettingsPath: '/s.json',
      daemonMcpConfigPath: '/m.json',
      appendSystemPrompt: 'be terse',
    },
    fresh: {
      cwd,
      backend: 'claude',
      transport: 'claude-daemon',
      prompt: 'build it',
      transportMeta: {
        mode: 'new',
        settingsPath: '/s.json',
        mcpConfigPath: '/m.json',
        appendSystemPrompt: 'be terse',
      },
    },
    expected: {
      daemonMode: 'new',
      daemonResumeSessionId: undefined,
      daemonAttachShort: undefined,
      daemonSettingsPath: '/s.json',
      daemonMcpConfigPath: '/m.json',
      appendSystemPrompt: 'be terse',
    },
  },
  {
    name: 'NEW minimal (prompt only)',
    legacy: { cwd, backend: 'daemon', daemonMode: 'new', prompt: 'go' },
    fresh: { cwd, backend: 'claude', transport: 'claude-daemon', prompt: 'go', transportMeta: { mode: 'new' } },
    expected: {
      daemonMode: 'new',
      daemonResumeSessionId: undefined,
      daemonAttachShort: undefined,
      daemonSettingsPath: undefined,
      daemonMcpConfigPath: undefined,
      appendSystemPrompt: undefined,
    },
  },
  {
    name: 'RESUME with resume session id',
    legacy: { cwd, backend: 'daemon', daemonMode: 'resume', daemonResumeSessionId: 'ccs_prior' },
    fresh: {
      cwd,
      backend: 'claude',
      transport: 'claude-daemon',
      transportMeta: { mode: 'resume', resumeSessionId: 'ccs_prior' },
    },
    expected: {
      daemonMode: 'resume',
      daemonResumeSessionId: 'ccs_prior',
      daemonAttachShort: undefined,
      daemonSettingsPath: undefined,
      daemonMcpConfigPath: undefined,
      appendSystemPrompt: undefined,
    },
  },
  {
    name: 'ATTACH (short only, no config)',
    legacy: { cwd, backend: 'daemon', daemonMode: 'attach', daemonAttachShort: 'aeb185f9' },
    fresh: {
      cwd,
      backend: 'claude',
      transport: 'claude-daemon',
      transportMeta: { mode: 'attach', attachShort: 'aeb185f9' },
    },
    expected: {
      daemonMode: 'attach',
      daemonResumeSessionId: undefined,
      daemonAttachShort: 'aeb185f9',
      daemonSettingsPath: undefined,
      daemonMcpConfigPath: undefined,
      appendSystemPrompt: undefined,
    },
  },
  {
    name: 'NEW via promoted top-level settingsPath/mcpConfigPath (no transportMeta keys)',
    legacy: {
      cwd,
      backend: 'daemon',
      daemonMode: 'new',
      prompt: 'go',
      daemonSettingsPath: '/s.json',
      daemonMcpConfigPath: '/m.json',
    },
    fresh: {
      cwd,
      backend: 'claude',
      transport: 'claude-daemon',
      prompt: 'go',
      settingsPath: '/s.json',
      mcpConfigPath: '/m.json',
      transportMeta: { mode: 'new' },
    },
    expected: {
      daemonMode: 'new',
      daemonResumeSessionId: undefined,
      daemonAttachShort: undefined,
      daemonSettingsPath: '/s.json',
      daemonMcpConfigPath: '/m.json',
      appendSystemPrompt: undefined,
    },
  },
]

describe('transport-reframe -- legacy shape resolves identically to the new shape', () => {
  for (const fx of fixtures) {
    describe(fx.name, () => {
      it('both shapes pass validatedSpawnRequestSchema', () => {
        expect(validatedSpawnRequestSchema.safeParse(fx.legacy).success).toBe(true)
        expect(validatedSpawnRequestSchema.safeParse(fx.fresh).success).toBe(true)
      })

      it('legacy normalizes to the expected effective daemon fields', () => {
        expect(effectiveDaemonFields(normalizeDaemonReq(fx.legacy))).toEqual(fx.expected)
      })

      it('new shape normalizes to the SAME effective daemon fields', () => {
        expect(effectiveDaemonFields(normalizeDaemonReq(fx.fresh))).toEqual(fx.expected)
      })

      it('legacy and new resolve to identical effective daemon fields', () => {
        expect(effectiveDaemonFields(normalizeDaemonReq(fx.fresh))).toEqual(
          effectiveDaemonFields(normalizeDaemonReq(fx.legacy)),
        )
      })
    })
  }
})

describe('transport-reframe -- transportMeta precedence over legacy flat fields', () => {
  it('prefers transportMeta values when BOTH shapes are present (dual-write)', () => {
    // A dual-write request where the new bag and the legacy fields disagree:
    // the new shape must win (the broker prefers transportMeta).
    const dualWrite: SpawnRequest = {
      cwd,
      backend: 'daemon',
      daemonMode: 'new',
      daemonResumeSessionId: 'legacy-resume',
      daemonSettingsPath: '/legacy.json',
      transport: 'claude-daemon',
      transportMeta: { mode: 'resume', resumeSessionId: 'meta-resume', settingsPath: '/meta.json' },
    }
    const norm = normalizeDaemonReq(dualWrite)
    expect(norm.daemonMode).toBe('resume')
    expect(norm.daemonResumeSessionId).toBe('meta-resume')
    expect(norm.daemonSettingsPath).toBe('/meta.json')
  })

  it('falls back to legacy flat fields when transportMeta omits a key', () => {
    const partialMeta: SpawnRequest = {
      cwd,
      backend: 'daemon',
      daemonMode: 'new',
      daemonSettingsPath: '/legacy.json',
      prompt: 'go',
      transport: 'claude-daemon',
      transportMeta: { mode: 'new' },
    }
    expect(normalizeDaemonReq(partialMeta).daemonSettingsPath).toBe('/legacy.json')
  })

  it('is a no-op when no transportMeta is present (pure legacy)', () => {
    const legacy: SpawnRequest = { cwd, backend: 'daemon', daemonMode: 'new', prompt: 'go' }
    expect(normalizeDaemonReq(legacy)).toBe(legacy)
  })
})
