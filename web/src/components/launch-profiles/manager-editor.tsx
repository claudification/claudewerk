import type { LaunchProfile } from '@shared/launch-profile'
import { backendSupportsAppendSystemPrompt } from '@shared/launch-profile'
import type { BackendKind } from '@/components/spawn-dialog/backend-select'
import {
  type ClaudeTransport,
  deriveClaudeTransport,
  isClaudeFamilyBackend,
  processModelToBackendHeadless,
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
  // Transport reframe (Phase 5): daemon is detected via the canonical
  // transport (`claude-daemon`), derived from the persisted (backend, headless)
  // shape with the legacy `backend === 'daemon'` as the dual-read.
  const transport: ClaudeTransport =
    (profile.spawn.transport as ClaudeTransport | undefined) ??
    deriveClaudeTransport(profile.spawn.backend, profile.spawn.headless ?? true)
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
    // Leaving the claude family drops the daemon launch config + transport.
    cleared.daemonMode = undefined
    cleared.daemonSettingsPath = undefined
    cleared.daemonMcpConfigPath = undefined
    cleared.transport = undefined
    patchSpawn(cleared)
  }

  // Process model picker for the claude family -- maps a chosen transport onto
  // the persisted (backend, headless) pair + writes the canonical `transport`.
  // Daemon seeds `daemonMode`; leaving daemon drops the daemon-only config.
  function switchProcessModel(pm: ClaudeTransport) {
    const next = processModelToBackendHeadless(pm, profile.spawn.headless ?? true)
    const patchSpawnValue: Partial<LaunchProfile['spawn']> = {
      backend: next.backend === 'daemon' ? 'daemon' : undefined,
      headless: next.headless,
      transport: pm,
    }
    if (next.backend === 'daemon') {
      patchSpawnValue.daemonMode = profile.spawn.daemonMode ?? 'new'
    } else {
      patchSpawnValue.daemonMode = undefined
      patchSpawnValue.daemonSettingsPath = undefined
      patchSpawnValue.daemonMcpConfigPath = undefined
    }
    patchSpawn(patchSpawnValue)
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <IdentitySection profile={profile} onPatch={patch} />
      <BehaviorSection profile={profile} onPatch={patch} />
      <BackendSection
        backend={backend === 'daemon' ? 'claude' : backend}
        onChange={switchBackend}
        hasIncompatibleFields={hasIncompatibleFields}
      />
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
  const isClaude = backend === 'claude'
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
  // Daemon-only injected paths are dropped by `switchBackend` on any move off
  // the daemon backend -- warn so the user does not lose them silently.
  if (backend === 'daemon') return !!(s.daemonSettingsPath || s.daemonMcpConfigPath)
  if (backend === 'opencode') return false
  return !!(s.appendSystemPrompt || s.openCodeModel || s.toolPermission)
}
