import type { LaunchProfile } from '@shared/launch-profile'
import { backendSupportsAppendSystemPrompt } from '@shared/launch-profile'
import type { BackendKind } from '@/components/spawn-dialog/backend-select'
import {
  type ClaudeTransport,
  deriveClaudeTransport,
  isClaudeFamilyBackend,
  processModelToState,
} from '@/components/spawn-dialog/process-model'
import { useConversationsStore } from '@/hooks/use-conversations'
import { launchFieldsFromProfile, spawnPatchFromLaunchFields } from './editor-mapping'
import {
  AppendSystemPromptSection,
  BackendSection,
  BehaviorSection,
  DaemonConfigSection,
  HiddenAppendPromptNotice,
  IdentitySection,
  LaunchFieldsSection,
  PinningSection,
  ProcessModelSection,
  SentinelProfileSection,
} from './editor-sections'

interface Props {
  profile: LaunchProfile
  onChange: (next: LaunchProfile) => void
}

export function ManagerEditor({ profile, onChange }: Props) {
  const backend = (profile.spawn.backend ?? 'claude') as BackendKind
  // The daemon is detected via the canonical `transport` discriminator. Daemon
  // profiles always persist `transport: 'claude-daemon'`; a profile without a
  // transport is a non-daemon claude launch, so the fallback derives PTY vs
  // headless from the stored launch mode (never daemon).
  const transport: ClaudeTransport =
    (profile.spawn.transport as ClaudeTransport | undefined) ??
    deriveClaudeTransport(false, profile.spawn.headless ?? true)
  const isDaemon = transport === 'claude-daemon'
  const showProcessModel = isClaudeFamilyBackend(backend)
  const showAppendSp = backendSupportsAppendSystemPrompt(backend)
  const hasIncompatibleFields = !showAppendSp ? false : hasBackendIncompatibleFields(profile, backend)
  const sentinels = useConversationsStore(s => s.sentinels)

  function patch(next: Partial<LaunchProfile>) {
    onChange({ ...profile, ...next, updatedAt: Date.now() })
  }

  function patchSpawn(next: Partial<LaunchProfile['spawn']>) {
    patch({ spawn: { ...profile.spawn, ...next } })
  }

  function switchBackend(next: BackendKind) {
    const cleared: Partial<LaunchProfile['spawn']> = { backend: next === 'claude' ? undefined : next }
    if (!backendSupportsAppendSystemPrompt(next)) cleared.appendSystemPrompt = undefined
    if (next !== 'opencode') {
      cleared.openCodeModel = undefined
      cleared.toolPermission = undefined
    }
    // Leaving the claude family drops the daemon transport + its injected config.
    cleared.transport = undefined
    cleared.settingsPath = undefined
    cleared.mcpConfigPath = undefined
    patchSpawn(cleared)
  }

  // Process model picker for the claude family -- writes the canonical
  // `transport` + the derived headless flag. Leaving daemon drops the daemon-only
  // injected config (settings / mcp paths).
  function switchProcessModel(pm: ClaudeTransport) {
    const next = processModelToState(pm, profile.spawn.headless ?? true)
    const patchSpawnValue: Partial<LaunchProfile['spawn']> = {
      backend: undefined,
      headless: next.headless,
      transport: pm,
    }
    if (!next.isDaemon) {
      patchSpawnValue.settingsPath = undefined
      patchSpawnValue.mcpConfigPath = undefined
    }
    patchSpawn(patchSpawnValue)
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <IdentitySection profile={profile} onPatch={patch} />
      <BehaviorSection profile={profile} onPatch={patch} />
      <BackendSection backend={backend} onChange={switchBackend} hasIncompatibleFields={hasIncompatibleFields} />
      {showProcessModel && <ProcessModelSection transport={transport} onChange={switchProcessModel} />}
      <SentinelProfileSection profile={profile} onPatchSpawn={patchSpawn} sentinels={sentinels} />
      {isDaemon && <DaemonConfigSection spawn={profile.spawn} onPatch={patchSpawn} />}
      <LaunchFieldsSection
        value={launchFieldsFromProfile(profile)}
        onPatch={p => patchSpawn(spawnPatchFromLaunchFields(p))}
        show={launchFieldsShowFor(backend, isDaemon)}
      />
      {showAppendSp ? (
        <AppendSystemPromptSection
          value={profile.spawn.appendSystemPrompt ?? ''}
          onChange={text => patchSpawn({ appendSystemPrompt: text || undefined })}
        />
      ) : (
        <HiddenAppendPromptNotice backend={backend} hasValue={!!profile.spawn.appendSystemPrompt} />
      )}
      <PinningSection profile={profile} onPatch={patch} />
    </div>
  )
}

/**
 * Which `LaunchConfigFields` rows a profile editor shows per backend. Daemon
 * dispatch only takes `--model`; effort / permission mode / agent / budgets
 * are claude/headless concepts. repl / bare / partial-messages are
 * claude-agent-host runtime flags. PTY-vs-Headless is now the Process model
 * control (transport reframe Phase 5), so the legacy headless toggle is gone.
 */
function launchFieldsShowFor(backend: BackendKind, isDaemon: boolean) {
  // The daemon transport rides the claude backend but is not the PTY/headless
  // agent host, so repl / bare / partial-messages (agent-host runtime flags)
  // do not apply to it.
  const isClaude = backend === 'claude' && !isDaemon
  return {
    model: true,
    effort: !isDaemon,
    permissionMode: !isDaemon,
    agent: !isDaemon,
    autocompactPct: !isDaemon,
    maxBudgetUsd: !isDaemon,
    repl: isClaude,
    bare: isClaude,
    includePartialMessages: isClaude,
  }
}

function hasBackendIncompatibleFields(profile: LaunchProfile, backend: BackendKind): boolean {
  const s = profile.spawn
  if (backend === 'opencode') return false
  return !!(s.appendSystemPrompt || s.openCodeModel || s.toolPermission)
}
