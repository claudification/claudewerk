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

// Single source of truth for the backend union -- includes 'daemon'.
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
  /** Daemon launch state -- only invoked when the profile's backend is daemon. */
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
  // Daemon profiles drive a separate config form (mode + DaemonModeFormValue),
  // not the generic per-field state -- restore that and stop. Transport reframe
  // (Phase 5): detect via the canonical transport, dual-read `backend`.
  if (s.transport === 'claude-daemon' || s.backend === 'daemon') {
    applyDaemonProfileToForm(s, setters)
    // Daemon launches also honor the sentinel-profile pick (the daemon worker
    // runs under the resolved profile's `CLAUDE_CONFIG_DIR`).
    if (setters.setSentinelProfile) setters.setSentinelProfile(s.profile ?? '')
    if (setters.setSentinelPool) setters.setSentinelPool(s.pool ?? '')
    return
  }
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
 * Restore a daemon launch profile into the spawn dialog's daemon state.
 * `prompt` / `resumeSessionId` are intentionally left blank -- they are
 * per-launch input the user supplies in the dialog (a profile never carries
 * them, see `profileSpawnSchema`).
 */
function applyDaemonProfileToForm(s: LaunchProfile['spawn'], setters: SpawnFormSetters): void {
  setters.setBackend('daemon')
  setters.setDaemonMode?.(s.daemonMode === 'resume' ? 'resume' : 'new')
  setters.setDaemonForm?.({
    ...blankDaemonForm(),
    model: s.model ?? '',
    appendSystemPrompt: s.appendSystemPrompt ?? '',
    envText: envObjectToText(s.env),
    settingsPath: s.daemonSettingsPath ?? '',
    mcpConfigPath: s.daemonMcpConfigPath ?? '',
    worktreeName: s.worktree ?? '',
  })
}

/**
 * Capture the daemon config form as a profile spawn slice. `attach` collapses
 * to `new` (a profile cannot pin an ephemeral attach target); `prompt` and
 * `resumeSessionId` are dropped -- they are per-launch only.
 */
function daemonFormToProfileSpawn(mode: DaemonMode, form: DaemonModeFormValue): LaunchProfile['spawn'] {
  const out: LaunchProfile['spawn'] = {
    backend: 'daemon',
    daemonMode: mode === 'resume' ? 'resume' : 'new',
  }
  const model = form.model.trim()
  if (model) out.model = model as LaunchProfile['spawn']['model']
  if (form.appendSystemPrompt.trim()) out.appendSystemPrompt = form.appendSystemPrompt
  const settings = form.settingsPath.trim()
  if (settings) out.daemonSettingsPath = settings
  const mcp = form.mcpConfigPath.trim()
  if (mcp) out.daemonMcpConfigPath = mcp
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
  /** Daemon launch state -- read only when `backend === 'daemon'`. */
  daemonMode?: DaemonMode
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
  // The daemon backend owns a separate config form -- snapshot it instead of
  // the generic per-field state (the generic fields are not daemon launch
  // params and would just bloat the profile).
  if (snap.backend === 'daemon') {
    const out = daemonFormToProfileSpawn(snap.daemonMode ?? 'new', snap.daemonForm ?? blankDaemonForm())
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
