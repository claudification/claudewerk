/**
 * Bridge between LaunchProfile.spawn and the spawn-dialog form state.
 *
 * The dialog already owns per-field useState setters; this module
 * provides a single applyProfileToForm() helper so the dropdown's
 * onChange handler doesn't pollute the dialog body.
 */

import type { LaunchProfile } from '@shared/launch-profile'
import { blankDaemonForm, type DaemonMode, type DaemonModeFormValue } from '@/components/spawn-dialog/daemon-launch'
import { parseEnvText } from '@/lib/env-parse'

// Single source of truth for the backend union (claude / chat-api / hermes /
// opencode). The daemon is the claude `claude-daemon` transport, not a backend.
export type { BackendKind } from '@/components/spawn-dialog/backend-select'

import type { BackendKind } from '@/components/spawn-dialog/backend-select'

export interface SpawnFormSetters {
  setHeadless: (v: boolean) => void
  setModel: (v: string) => void
  setEffort: (v: string) => void
  setAgent: (v: string) => void
  setBare: (v: boolean) => void
  setRepl: (v: boolean) => void
  setPermissionMode: (v: string) => void
  setAutocompactPct: (v: number | '') => void
  setMaxBudgetUsd: (v: string) => void
  setIncludePartialMessages: (v: boolean) => void
  setBackend: (v: BackendKind) => void
  setEnvText: (v: string) => void
  setOpenCodeModel?: (v: string) => void
  setOpenCodeToolPermission?: (v: 'none' | 'safe' | 'full') => void
  /** Daemon process model selector -- true for the `claude-daemon` transport. */
  setIsDaemon?: (v: boolean) => void
  /** Daemon launch state -- only invoked for a daemon (`claude-daemon`) profile. */
  setDaemonMode?: (v: DaemonMode) => void
  setDaemonForm?: (v: DaemonModeFormValue) => void
  /** Sentinel-profile INTENT -- either a literal profile name or a
   *  SelectionMode token (`default` | `balanced` | `random`). Optional so
   *  callers that don't yet wire the radio can stay agnostic. */
  setSentinelProfile?: (v: string) => void
  /** Sentinel-pool INTENT (Balanced/Random only) -- the named pool to draw
   *  from. Optional; callers that don't yet render the pool picker can stay
   *  agnostic and the sentinel falls back to its `defaultPool`. */
  setSentinelPool?: (v: string) => void
}

export function applyProfileToForm(profile: LaunchProfile, setters: SpawnFormSetters): void {
  const s = profile.spawn
  // Daemon profiles drive a separate config form (DaemonModeFormValue), not the
  // generic per-field state -- restore that and stop. Detected via the canonical
  // `transport` discriminator.
  if (s.transport === 'claude-daemon') {
    applyDaemonProfileToForm(s, setters)
    // Daemon launches also honor the sentinel-profile pick (the daemon worker
    // runs under the resolved profile's `CLAUDE_CONFIG_DIR`).
    if (setters.setSentinelProfile) setters.setSentinelProfile(s.profile ?? '')
    if (setters.setSentinelPool) setters.setSentinelPool(s.pool ?? '')
    return
  }
  setters.setIsDaemon?.(false)
  if (s.headless !== undefined) setters.setHeadless(s.headless)
  setters.setModel(s.model ?? '')
  setters.setEffort(s.effort ?? '')
  setters.setAgent(s.agent ?? '')
  setters.setBare(s.bare ?? false)
  setters.setRepl(s.repl ?? false)
  setters.setPermissionMode(s.permissionMode ?? '')
  setters.setAutocompactPct(s.autocompactPct ?? '')
  setters.setMaxBudgetUsd(s.maxBudgetUsd != null ? String(s.maxBudgetUsd) : '')
  if (s.includePartialMessages !== undefined) setters.setIncludePartialMessages(s.includePartialMessages)
  if (s.backend) setters.setBackend(s.backend as BackendKind)
  setters.setEnvText(envObjectToText(s.env))
  if (s.openCodeModel && setters.setOpenCodeModel) setters.setOpenCodeModel(s.openCodeModel)
  if (s.toolPermission && setters.setOpenCodeToolPermission) setters.setOpenCodeToolPermission(s.toolPermission)
  // Sentinel-profile intent -- empty string = follow sentinel default.
  if (setters.setSentinelProfile) setters.setSentinelProfile(s.profile ?? '')
  // Sentinel-pool intent (Balanced/Random) -- empty string = follow defaultPool.
  if (setters.setSentinelPool) setters.setSentinelPool(s.pool ?? '')
}

function envObjectToText(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/**
 * Restore a daemon launch profile into the spawn dialog's daemon state. A
 * daemon profile is always NEW-mode (resume / attach are per-launch only), so
 * the mode is seeded to `new`; `prompt` / `resumeSessionId` are left blank --
 * per-launch input the user supplies in the dialog. The injected paths ride the
 * web-readable `settingsPath` / `mcpConfigPath` typed fields (the opaque
 * `transportMeta` bag is broker-only -- the control panel never reads it).
 */
function applyDaemonProfileToForm(s: LaunchProfile['spawn'], setters: SpawnFormSetters): void {
  setters.setBackend('claude')
  setters.setIsDaemon?.(true)
  setters.setDaemonMode?.('new')
  setters.setDaemonForm?.({
    ...blankDaemonForm(),
    model: s.model ?? '',
    appendSystemPrompt: s.appendSystemPrompt ?? '',
    envText: envObjectToText(s.env),
    settingsPath: s.settingsPath ?? '',
    mcpConfigPath: s.mcpConfigPath ?? '',
    worktreeName: s.worktree ?? '',
  })
}

/**
 * Capture the daemon config form as a profile spawn slice. A daemon profile is
 * always NEW-mode (`attach` / `resume` target an ephemeral worker/session the
 * user supplies at launch); `prompt` / `resumeSessionId` are dropped. The
 * injected paths ride the web-readable `settingsPath` / `mcpConfigPath` typed
 * fields; the canonical `transport: 'claude-daemon'` is the discriminator.
 */
function daemonFormToProfileSpawn(form: DaemonModeFormValue): LaunchProfile['spawn'] {
  const out: LaunchProfile['spawn'] = { backend: 'claude', transport: 'claude-daemon' }
  const model = form.model.trim()
  if (model) out.model = model as LaunchProfile['spawn']['model']
  if (form.appendSystemPrompt.trim()) out.appendSystemPrompt = form.appendSystemPrompt
  const settings = form.settingsPath.trim()
  if (settings) out.settingsPath = settings
  const mcp = form.mcpConfigPath.trim()
  if (mcp) out.mcpConfigPath = mcp
  const worktree = form.worktreeName.trim()
  if (worktree) out.worktree = worktree
  const [env] = parseEnvText(form.envText)
  if (env && Object.keys(env).length) out.env = env
  return out
}

export interface FormSnapshotInput {
  model: string
  effort: string
  agent: string
  permissionMode: string
  autocompactPct: number | ''
  maxBudgetUsd: string
  headless: boolean
  bare: boolean
  repl: boolean
  includePartialMessages: boolean
  backend: BackendKind
  envText: string
  openCodeModel?: string
  toolPermission?: 'none' | 'safe' | 'full'
  /** True when the claude daemon process model (`claude-daemon`) is selected. */
  isDaemon?: boolean
  /** Daemon launch config -- read only when `isDaemon`. */
  daemonForm?: DaemonModeFormValue
  /** Sentinel-profile INTENT -- empty string omits the field (sentinel
   *  applies its `defaultSelection`). Stored verbatim on the launch
   *  profile's `spawn.profile`. */
  sentinelProfile?: string
  /** Sentinel-pool INTENT (Balanced/Random only). Empty string omits the
   *  field (sentinel applies its `defaultPool`). Stored verbatim on the
   *  launch profile's `spawn.pool`. */
  sentinelPool?: string
}

/**
 * Capture the spawn dialog's current form state as a profile draft so the
 * user can hit "Save as profile..." without retyping anything.
 */
export function formSnapshotToProfileSpawn(snap: FormSnapshotInput): LaunchProfile['spawn'] {
  // The daemon transport owns a separate config form -- snapshot it instead of
  // the generic per-field state (the generic fields are not daemon launch
  // params and would just bloat the profile).
  if (snap.isDaemon) {
    const out = daemonFormToProfileSpawn(snap.daemonForm ?? blankDaemonForm())
    if (snap.sentinelProfile) out.profile = snap.sentinelProfile
    if (snap.sentinelPool) out.pool = snap.sentinelPool
    return out
  }
  const out: LaunchProfile['spawn'] = {}
  if (snap.model) out.model = snap.model as LaunchProfile['spawn']['model']
  if (snap.effort) out.effort = snap.effort as LaunchProfile['spawn']['effort']
  if (snap.agent) out.agent = snap.agent
  if (snap.permissionMode) {
    out.permissionMode = snap.permissionMode as LaunchProfile['spawn']['permissionMode']
  }
  if (snap.autocompactPct !== '') out.autocompactPct = Number(snap.autocompactPct)
  const budgetNum = Number(snap.maxBudgetUsd)
  if (Number.isFinite(budgetNum) && budgetNum > 0) out.maxBudgetUsd = budgetNum
  out.headless = snap.headless
  if (snap.bare) out.bare = true
  if (snap.repl) out.repl = true
  out.includePartialMessages = snap.includePartialMessages
  if (snap.backend !== 'claude') out.backend = snap.backend
  const env = parseEnvSimple(snap.envText)
  if (env && Object.keys(env).length) out.env = env
  if (snap.openCodeModel) out.openCodeModel = snap.openCodeModel
  if (snap.toolPermission) out.toolPermission = snap.toolPermission
  if (snap.sentinelProfile) out.profile = snap.sentinelProfile
  if (snap.sentinelPool) out.pool = snap.sentinelPool
  return out
}

function parseEnvSimple(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}
