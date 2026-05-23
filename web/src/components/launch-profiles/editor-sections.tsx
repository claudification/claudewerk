import type { LaunchProfile } from '@shared/launch-profile'
import { LAUNCH_PROFILE_MAX_APPEND_SP } from '@shared/launch-profile'
import { DEFAULT_SENTINEL_NAME, parseProjectUri } from '@shared/project-uri'
import type { ComponentProps } from 'react'
import { LaunchConfigFields, type LaunchFieldsValue } from '@/components/launch-config-fields'
import { type BackendKind, BackendSelect } from '@/components/spawn-dialog/backend-select'
import type { ClaudeTransport } from '@/components/spawn-dialog/process-model'
import { ProcessModelSegmented } from '@/components/spawn-dialog/process-model-segmented'
import { SentinelProfileRadio } from '@/components/spawn-dialog/sentinel-profile-radio'
import { TogglePill } from '@/components/ui/toggle-pill'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import { formatShortcut } from '@/lib/commands'
import { LabeledRow, Section } from './editor-shell'
import { ProjectUriField } from './project-uri-field'

type LaunchFieldsShow = ComponentProps<typeof LaunchConfigFields>['show']

const DEFAULT_FIELDS_SHOW: LaunchFieldsShow = {
  model: true,
  effort: true,
  permissionMode: true,
  agent: true,
  autocompactPct: true,
  maxBudgetUsd: true,
}

type PatchProfile = (next: Partial<LaunchProfile>) => void

export function IdentitySection({ profile, onPatch }: { profile: LaunchProfile; onPatch: PatchProfile }) {
  return (
    <Section title="Identity">
      <LabeledRow label="Name">
        <TextInput
          value={profile.name}
          onChange={v => onPatch({ name: v })}
          placeholder="Profile name"
          maxWidth={260}
        />
      </LabeledRow>
      <LabeledRow label="Short label" subtitle="Shown on the spawn-dialog dropdown chip">
        <TextInput
          value={profile.shortLabel ?? ''}
          onChange={v => onPatch({ shortLabel: v || undefined })}
          placeholder={profile.name.slice(0, 12)}
          maxWidth={220}
        />
      </LabeledRow>
      <LabeledRow label="Chord key" subtitle={profile.chord ? formatShortcut(`mod+j ${profile.chord}`) : '(no chord)'}>
        <TextInput
          value={profile.chord ?? ''}
          onChange={v => onPatch({ chord: v.toLowerCase().slice(0, 3) || undefined })}
          placeholder="o"
          width={64}
        />
      </LabeledRow>
    </Section>
  )
}

export function BehaviorSection({ profile, onPatch }: { profile: LaunchProfile; onPatch: PatchProfile }) {
  const immediate = profile.immediate ?? true
  return (
    <Section title="Behavior">
      <LabeledRow
        label="Immediate launch"
        subtitle={immediate ? 'Fires straight to the broker on chord' : 'Opens the spawn dialog pre-filled'}
      >
        <TogglePill
          small
          label={immediate ? 'On' : 'Off'}
          active={immediate}
          onClick={() => onPatch({ immediate: !immediate })}
        />
      </LabeledRow>
    </Section>
  )
}

export function BackendSection({
  backend,
  onChange,
  hasIncompatibleFields,
}: {
  backend: BackendKind
  onChange: (next: BackendKind) => void
  hasIncompatibleFields: boolean
}) {
  function handleChange(next: BackendKind) {
    if (next === backend) return
    if (hasIncompatibleFields) {
      const ok = window.confirm('Switching backend will clear fields the new backend cannot use. Continue?')
      if (!ok) return
    }
    onChange(next)
  }
  return (
    <Section title="Backend">
      <BackendSelect value={backend} onChange={handleChange} chatAvailable hermesAvailable />
    </Section>
  )
}

/**
 * Process model picker for the claude family: Interactive PTY / Headless /
 * Daemon. Maps to the `transport` discriminator.
 */
export function ProcessModelSection({
  transport,
  onChange,
}: {
  transport: ClaudeTransport
  onChange: (transport: ClaudeTransport) => void
}) {
  return (
    <Section title="Process model">
      <ProcessModelSegmented value={transport} onChange={onChange} showHeading={false} />
    </Section>
  )
}

export function LaunchFieldsSection({
  value,
  onPatch,
  show = DEFAULT_FIELDS_SHOW,
}: {
  value: LaunchFieldsValue
  onPatch: (p: Partial<LaunchFieldsValue>) => void
  show?: LaunchFieldsShow
}) {
  return (
    <Section title="Launch fields">
      <LaunchConfigFields value={value} onChange={onPatch} show={show} />
    </Section>
  )
}

export function AppendSystemPromptSection({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  return (
    <Section
      title="System prompt suffix"
      subtitle="Appended to CC's generated system prompt. CC: --append-system-prompt"
    >
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={6}
        placeholder="e.g. Be terse. Prefer bullet points. Skip apologies."
        className="w-full text-xs font-mono bg-surface-inset border border-primary/20 px-2 py-1 outline-none resize-y"
        maxLength={LAUNCH_PROFILE_MAX_APPEND_SP}
      />
      <div className="text-[10px] text-muted-foreground text-right">
        {value.length} / {LAUNCH_PROFILE_MAX_APPEND_SP}
      </div>
    </Section>
  )
}

export function HiddenAppendPromptNotice({ backend, hasValue }: { backend: BackendKind; hasValue: boolean }) {
  return (
    <Section title="System prompt suffix">
      <div className="text-[11px] text-muted-foreground">
        Hidden because the <span className="text-foreground">{backend}</span> backend cannot honor an appended system
        prompt at spawn time.
      </div>
      {hasValue && (
        <div className="text-[11px] text-warning">
          A suffix is already saved; it will be ignored on launch until you switch to claude or chat-api.
        </div>
      )}
    </Section>
  )
}

/**
 * Daemon-specific launch config for a profile: the sentinel-host config paths
 * injected when the daemon worker is dispatched. Rendered only when the
 * profile's transport is `claude-daemon`. A daemon profile is always NEW-mode:
 * RESUME / ATTACH target an ephemeral session/worker the user supplies in the
 * spawn dialog, so they are per-launch only and never saved to a profile. The
 * paths ride the backend-general `settingsPath` / `mcpConfigPath` fields (the
 * web-readable typed shape -- the opaque `transportMeta` bag is broker-only).
 */
export function DaemonConfigSection({
  spawn,
  onPatch,
}: {
  spawn: LaunchProfile['spawn']
  onPatch: (next: Partial<LaunchProfile['spawn']>) => void
}) {
  return (
    <Section
      title="Daemon launch"
      subtitle="A new worker is dispatched at launch. Resume / attach are per-launch only."
    >
      <LabeledRow label="Settings path" subtitle="Absolute path on the sentinel host. claude --settings">
        <TextInput
          value={spawn.settingsPath ?? ''}
          onChange={v => onPatch({ settingsPath: v || undefined })}
          placeholder="/abs/path/to/settings.json"
          maxWidth={260}
        />
      </LabeledRow>
      <LabeledRow label="MCP config path" subtitle="Absolute path on the sentinel host. claude --mcp-config">
        <TextInput
          value={spawn.mcpConfigPath ?? ''}
          onChange={v => onPatch({ mcpConfigPath: v || undefined })}
          placeholder="/abs/path/to/mcp.json"
          maxWidth={260}
        />
      </LabeledRow>
    </Section>
  )
}

/**
 * Resolve which sentinel a profile would route to so the Sentinel-profile
 * radio knows which profiles to offer. A pinned URI's authority wins
 * (`claude://{sentinel}/path`); otherwise we fall back to the legacy
 * `profile.sentinel` field, finally to the broker's default sentinel.
 */
function resolveTargetSentinelAlias(profile: LaunchProfile): string {
  if (profile.project) {
    try {
      const parsed = parseProjectUri(profile.project)
      if (parsed.authority) return parsed.authority
    } catch {
      // fall through -- unparseable URI is handled elsewhere
    }
  }
  if (profile.sentinel) return profile.sentinel
  return DEFAULT_SENTINEL_NAME
}

export function SentinelProfileSection({
  profile,
  onPatchSpawn,
  sentinels,
}: {
  profile: LaunchProfile
  onPatchSpawn: (next: Partial<LaunchProfile['spawn']>) => void
  sentinels: SentinelStatusInfo[]
}) {
  const targetAlias = resolveTargetSentinelAlias(profile)
  const targetSentinel = sentinels.find(s => s.alias.toLowerCase() === targetAlias.toLowerCase())
  const profiles = targetSentinel?.profiles ?? []
  const pools = targetSentinel?.pools ?? []
  const defaultPool = targetSentinel?.defaultPool

  const subtitle = targetSentinel
    ? `Target sentinel: ${targetAlias}`
    : `Sentinel "${targetAlias}" is not reporting -- selection follows its default at launch.`

  return (
    <Section title="Sentinel profile" subtitle={subtitle}>
      {profiles.length > 1 ? (
        <SentinelProfileRadio
          profiles={profiles}
          pools={pools}
          defaultPool={defaultPool}
          value={profile.spawn.profile ?? ''}
          onChange={v => onPatchSpawn({ profile: v || undefined })}
          poolValue={profile.spawn.pool ?? ''}
          onPoolChange={v => onPatchSpawn({ pool: v || undefined })}
        />
      ) : (
        <div className="text-[11px] text-muted-foreground">
          {targetSentinel
            ? `Sentinel "${targetAlias}" reports ${profiles.length} profile${profiles.length === 1 ? '' : 's'} -- nothing to pick. Launches use the sentinel's default.`
            : 'No profile choices available offline. Saved selection is preserved.'}
          {(profile.spawn.profile || profile.spawn.pool) && (
            <div className="mt-1 text-[10px] text-comment font-mono">
              Saved: profile={profile.spawn.profile ?? '(default)'} pool={profile.spawn.pool ?? '(default)'}
              <button
                type="button"
                className="ml-2 underline hover:text-foreground"
                onClick={() => onPatchSpawn({ profile: undefined, pool: undefined })}
              >
                clear
              </button>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

export function PinningSection({ profile, onPatch }: { profile: LaunchProfile; onPatch: PatchProfile }) {
  return (
    <Section title="Pinning" subtitle="Optional. Empty = pick at launch time. The URI authority is the sentinel.">
      <ProjectUriField value={profile.project ?? ''} onChange={v => onPatch({ project: v || undefined })} />
    </Section>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  maxWidth,
  width,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  maxWidth?: number
  width?: number
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={maxWidth ? { maxWidth, flex: 1 } : width ? { width } : undefined}
      className="text-xs font-mono bg-surface-inset border border-primary/20 px-2 py-1 outline-none"
    />
  )
}
