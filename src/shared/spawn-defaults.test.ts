import { describe, expect, it } from 'bun:test'
import type { LaunchProfile } from './launch-profile'
import {
  type DefaultsSource,
  profileToDefaultsSource,
  profileToSpawnPartial,
  resolveDefaultTransport,
  resolveSpawnConfig,
} from './spawn-defaults'
import type { SpawnRequest } from './spawn-schema'

function makeProfile(spawn: LaunchProfile['spawn'] = {}): LaunchProfile {
  return {
    id: 'lp_test',
    name: 'Test',
    spawn,
    createdAt: 0,
    updatedAt: 0,
  }
}

const emptyProj: DefaultsSource = {}
const emptyGlobal: DefaultsSource = {}

describe('resolveSpawnConfig', () => {
  describe('model', () => {
    it('uses project default when explicit is missing', () => {
      expect(resolveSpawnConfig({}, { defaultModel: 'sonnet' }, null).model).toBe('sonnet')
    })

    it('explicit wins over project default', () => {
      expect(
        resolveSpawnConfig({ model: 'opus' as SpawnRequest['model'] }, { defaultModel: 'sonnet' }, null).model,
      ).toBe('opus')
    })

    it('project wins over global', () => {
      expect(resolveSpawnConfig({}, { defaultModel: 'sonnet' }, { defaultModel: 'opus' }).model).toBe('sonnet')
    })

    it('falls back to global when project is empty', () => {
      expect(resolveSpawnConfig({}, emptyProj, { defaultModel: 'opus' }).model).toBe('opus')
    })

    it('empty-string default means unset', () => {
      expect(resolveSpawnConfig({}, null, { defaultModel: '' }).model).toBeUndefined()
    })

    it('undefined when nothing set', () => {
      expect(resolveSpawnConfig({}, null, null).model).toBeUndefined()
    })
  })

  describe('effort', () => {
    it("'default' sentinel in project default means unset", () => {
      expect(resolveSpawnConfig({}, { defaultEffort: 'default' }, null).effort).toBeUndefined()
    })

    it('respects real project effort', () => {
      expect(resolveSpawnConfig({}, { defaultEffort: 'high' }, null).effort).toBe('high')
    })

    it("'default' sentinel at global level means unset", () => {
      expect(resolveSpawnConfig({}, null, { defaultEffort: 'default' }).effort).toBeUndefined()
    })
  })

  describe('permissionMode', () => {
    it('adHoc forces bypassPermissions', () => {
      expect(resolveSpawnConfig({ adHoc: true }, null, null).permissionMode).toBe('bypassPermissions')
    })

    it('adHoc overrides explicit permissionMode', () => {
      expect(
        resolveSpawnConfig({ adHoc: true, permissionMode: 'plan' as SpawnRequest['permissionMode'] }, null, null)
          .permissionMode,
      ).toBe('bypassPermissions')
    })

    it('respects explicit permissionMode when not adHoc', () => {
      expect(
        resolveSpawnConfig({ permissionMode: 'acceptEdits' as SpawnRequest['permissionMode'] }, null, null)
          .permissionMode,
      ).toBe('acceptEdits')
    })

    it("'default' sentinel means unset", () => {
      expect(resolveSpawnConfig({}, { defaultPermissionMode: 'default' }, null).permissionMode).toBeUndefined()
    })
  })

  describe('headless', () => {
    it('adHoc always forces headless=true', () => {
      expect(resolveSpawnConfig({ adHoc: true }, null, null).headless).toBe(true)
    })

    it('adHoc overrides global defaultLaunchMode=pty', () => {
      expect(resolveSpawnConfig({ adHoc: true }, null, { defaultLaunchMode: 'pty' }).headless).toBe(true)
    })

    it('explicit headless=false wins when not adHoc', () => {
      expect(resolveSpawnConfig({ headless: false }, null, { defaultLaunchMode: 'headless' }).headless).toBe(false)
    })

    it('project defaultLaunchMode=pty yields headless=false', () => {
      expect(resolveSpawnConfig({}, { defaultLaunchMode: 'pty' }, null).headless).toBe(false)
    })

    it('defaults to headless=false (PTY) when nothing set', () => {
      expect(resolveSpawnConfig({}, null, null).headless).toBe(false)
    })

    it('global defaultLaunchMode=headless opts back into headless', () => {
      expect(resolveSpawnConfig({}, null, { defaultLaunchMode: 'headless' }).headless).toBe(true)
    })

    it('defaultTransport.claude=claude-headless opts into headless', () => {
      expect(resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-headless' } }).headless).toBe(true)
    })

    it('defaultTransport.claude=claude-pty yields PTY', () => {
      expect(resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-pty' } }).headless).toBe(false)
    })

    it('defaultTransport supersedes defaultLaunchMode at the global tier', () => {
      expect(
        resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-headless' }, defaultLaunchMode: 'pty' })
          .headless,
      ).toBe(true)
      expect(
        resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-pty' }, defaultLaunchMode: 'headless' })
          .headless,
      ).toBe(false)
    })

    it('project defaultLaunchMode still overrides defaultTransport', () => {
      expect(
        resolveSpawnConfig({}, { defaultLaunchMode: 'pty' }, { defaultTransport: { claude: 'claude-headless' } })
          .headless,
      ).toBe(false)
    })

    it('defaultTransport.claude=claude-daemon resolves to a non-headless (PTY-ish) launch mode', () => {
      // headless is moot for the daemon transport, but must not be left true.
      expect(resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-daemon' } }).headless).toBe(false)
    })
  })

  describe('defaultTransport (the cutover knob)', () => {
    it('defaultTransport.claude=claude-daemon resolves to the claude-daemon transport, backend stays claude', () => {
      const out = resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-daemon' } })
      // daemon is a transport, NOT a backend -- the backend stays unset (claude).
      expect(out.backend).toBeUndefined()
      expect(out.transport).toBe('claude-daemon')
    })

    it('defaultTransport.claude=claude-pty resolves to claude / PTY', () => {
      const out = resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-pty' } })
      expect(out.backend).toBeUndefined()
      expect(out.headless).toBe(false)
      expect(out.transport).toBe('claude-pty')
    })

    it('defaultTransport.claude=claude-headless resolves to claude / headless', () => {
      const out = resolveSpawnConfig({}, null, { defaultTransport: { claude: 'claude-headless' } })
      expect(out.backend).toBeUndefined()
      expect(out.headless).toBe(true)
      expect(out.transport).toBe('claude-headless')
    })

    it('unset defaultTransport leaves the backend unset (claude) and derives PTY', () => {
      const out = resolveSpawnConfig({}, null, null)
      expect(out.backend).toBeUndefined()
      expect(out.transport).toBe('claude-pty')
    })

    it('an explicit transport always wins over the global default', () => {
      expect(
        resolveSpawnConfig({ transport: 'claude-pty' }, null, { defaultTransport: { claude: 'claude-daemon' } })
          .transport,
      ).toBe('claude-pty')
    })

    it('an explicit non-claude backend ignores the claude default transport', () => {
      const out = resolveSpawnConfig({ backend: 'opencode' }, null, { defaultTransport: { claude: 'claude-daemon' } })
      expect(out.backend).toBe('opencode')
      expect(out.transport).toBeUndefined()
    })

    it('adHoc spawns never adopt the daemon transport even with defaultTransport=claude-daemon', () => {
      const out = resolveSpawnConfig({ adHoc: true }, null, { defaultTransport: { claude: 'claude-daemon' } })
      expect(out.transport).toBe('claude-headless')
    })
  })

  describe('resolveDefaultTransport', () => {
    it('an explicit transport always wins', () => {
      const d = resolveDefaultTransport({ transport: 'claude-pty' }, { defaultTransport: { claude: 'claude-daemon' } })
      expect(d.transport).toBe('claude-pty')
      expect(d.reason).toContain('explicit transport')
    })

    it('a non-claude explicit backend gets no transport', () => {
      const d = resolveDefaultTransport({ backend: 'opencode' }, { defaultTransport: { claude: 'claude-daemon' } })
      expect(d.backend).toBe('opencode')
      expect(d.transport).toBeUndefined()
    })

    it('adHoc resolves to the claude headless path (derived), never daemon', () => {
      const d = resolveDefaultTransport({ adHoc: true }, { defaultTransport: { claude: 'claude-daemon' } })
      expect(d.transport).toBeUndefined()
      expect(d.reason).toContain('adHoc')
    })

    it('defaultTransport.claude=claude-daemon stamps the claude-daemon transport with a descriptive reason', () => {
      const d = resolveDefaultTransport({}, { defaultTransport: { claude: 'claude-daemon' } })
      expect(d.backend).toBeUndefined()
      expect(d.transport).toBe('claude-daemon')
      expect(d.reason).toContain('defaultTransport.claude=claude-daemon')
    })

    it('an explicit headless toggle defers the transport (does not stamp claude-daemon)', () => {
      const d = resolveDefaultTransport({ headless: false }, { defaultTransport: { claude: 'claude-daemon' } })
      expect(d.transport).toBeUndefined()
    })

    it('claude-pty / claude-headless / unset defaults defer to the derived transport', () => {
      expect(resolveDefaultTransport({}, { defaultTransport: { claude: 'claude-pty' } }).transport).toBeUndefined()
      expect(resolveDefaultTransport({}, { defaultTransport: { claude: 'claude-headless' } }).transport).toBeUndefined()
      expect(resolveDefaultTransport({}, null).transport).toBeUndefined()
    })
  })

  describe('numerics (autocompactPct, maxBudgetUsd)', () => {
    it('zero in project default means unset', () => {
      expect(resolveSpawnConfig({}, { defaultAutocompactPct: 0 }, { defaultAutocompactPct: 80 }).autocompactPct).toBe(
        80,
      )
    })

    it('explicit positive wins', () => {
      expect(resolveSpawnConfig({ autocompactPct: 50 }, { defaultAutocompactPct: 80 }, null).autocompactPct).toBe(50)
    })

    it('maxBudgetUsd falls back across levels', () => {
      expect(resolveSpawnConfig({}, null, { defaultMaxBudgetUsd: 5 }).maxBudgetUsd).toBe(5)
      expect(resolveSpawnConfig({}, null, { defaultMaxBudgetUsd: 0 }).maxBudgetUsd).toBeUndefined()
    })
  })

  describe('booleans (bare, repl)', () => {
    it('explicit false overrides project true', () => {
      expect(resolveSpawnConfig({ bare: false }, { defaultBare: true }, null).bare).toBe(false)
    })

    it('falls back to project', () => {
      expect(resolveSpawnConfig({}, { defaultBare: true }, null).bare).toBe(true)
    })

    it('falls back to global when project is undefined', () => {
      expect(resolveSpawnConfig({}, null, { defaultRepl: true }).repl).toBe(true)
    })
  })

  describe('profile tier', () => {
    const profile = profileToDefaultsSource(makeProfile({ model: 'claude-opus-4-7', effort: 'high' }))

    it('profile wins over project', () => {
      expect(resolveSpawnConfig({}, { defaultModel: 'claude-haiku-4-5' }, null, profile).model).toBe('claude-opus-4-7')
    })

    it('explicit still wins over profile', () => {
      expect(
        resolveSpawnConfig({ model: 'claude-haiku-4-5' as SpawnRequest['model'] }, null, null, profile).model,
      ).toBe('claude-haiku-4-5')
    })

    it('profile beats global when project is empty', () => {
      expect(resolveSpawnConfig({}, {}, { defaultModel: 'claude-haiku-4-5' }, profile).model).toBe('claude-opus-4-7')
    })

    it('profile.effort tier slots between explicit and project', () => {
      expect(resolveSpawnConfig({}, { defaultEffort: 'low' }, null, profile).effort).toBe('high')
    })

    it('null profile leaves the resolver unchanged', () => {
      const out = resolveSpawnConfig({}, { defaultModel: 'claude-haiku-4-5' }, null, null)
      expect(out.model).toBe('claude-haiku-4-5')
    })

    it('headless field on profile maps to defaultLaunchMode', () => {
      const ptyProfile = profileToDefaultsSource(makeProfile({ headless: false }))
      expect(resolveSpawnConfig({}, null, null, ptyProfile).headless).toBe(false)
    })

    it('explicit headless wins over profile launch mode', () => {
      const ptyProfile = profileToDefaultsSource(makeProfile({ headless: false }))
      expect(resolveSpawnConfig({ headless: true }, null, null, ptyProfile).headless).toBe(true)
    })
  })

  describe('profileToSpawnPartial', () => {
    it('returns the empty object for null profiles', () => {
      expect(profileToSpawnPartial(null)).toEqual({})
    })

    it('copies non-default fields', () => {
      const p = makeProfile({ backend: 'claude', appendSystemPrompt: 'be terse', env: { FOO: '1' } })
      const partial = profileToSpawnPartial(p)
      expect(partial.backend).toBe('claude')
      expect(partial.appendSystemPrompt).toBe('be terse')
      expect(partial.env).toEqual({ FOO: '1' })
    })

    it('does not copy resolver-managed fields like model', () => {
      const p = makeProfile({ model: 'claude-opus-4-7', backend: 'claude' })
      const partial = profileToSpawnPartial(p)
      expect(partial.model).toBeUndefined()
      expect(partial.backend).toBe('claude')
    })
  })

  it('preserves other request fields untouched', () => {
    const partial: Partial<SpawnRequest> = {
      cwd: '/tmp/x',
      mkdir: true,
      prompt: 'hi',
      worktree: 'feat-x',
      adHoc: false,
    }
    const out = resolveSpawnConfig(partial, emptyProj, emptyGlobal)
    expect(out.cwd).toBe('/tmp/x')
    expect(out.mkdir).toBe(true)
    expect(out.prompt).toBe('hi')
    expect(out.worktree).toBe('feat-x')
  })
})
