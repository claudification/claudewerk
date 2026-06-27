/**
 * daemon-launch -- pure helpers for the spawn dialog's claude-daemon transport.
 *
 * Three launch modes ride the `transportMeta.mode` discriminator (plan
 * `.claude/docs/plan-daemon-launch-ux.md` Section 2):
 *   - new:    dispatch a fresh worker                -- prompt optional
 *   - resume: dispatch --resume <sessionId>          -- resume session id required
 *   - attach: attach to a roster worker (no dispatch) -- 8-hex short required
 *
 * This module is side-effect free and DOM-free so the validation + spawn-request
 * shaping is unit-testable without rendering the dialog.
 */

import type { SpawnRequest } from '@shared/spawn-schema'
import { parseEnvText } from '@/lib/env-parse'

export type DaemonMode = 'new' | 'resume' | 'attach'

/**
 * Editable config for a one-off daemon NEW / RESUME launch. ATTACH carries no
 * config -- the worker was already configured by whoever dispatched it.
 */
export interface DaemonModeFormValue {
  /** First-turn prompt. Required for NEW, optional for RESUME. */
  prompt: string
  /** Claude model id, or '' for the project/global default. */
  model: string
  /** Appended to CC's system prompt (`claude --bg --append-system-prompt`). */
  appendSystemPrompt: string
  /** KEY=value-per-line env block, merged into the worker process env. */
  envText: string
  /** Absolute path on the sentinel host (`claude --bg --settings`). */
  settingsPath: string
  /** Absolute path on the sentinel host (`claude --bg --mcp-config`). */
  mcpConfigPath: string
  /** Optional git worktree branch name. */
  worktreeName: string
  /** RESUME only: the daemon session id to fork from (`--resume <id>`). */
  resumeSessionId: string
}

/** A fresh, empty NEW/RESUME config form. */
export function blankDaemonForm(): DaemonModeFormValue {
  return {
    prompt: '',
    model: '',
    appendSystemPrompt: '',
    envText: '',
    settingsPath: '',
    mcpConfigPath: '',
    worktreeName: '',
    resumeSessionId: '',
  }
}

/**
 * Soft client-side check: a settings / mcp-config path, when set, must look
 * absolute. The sentinel does the real `existsSync` -- this only catches the
 * obvious typo before a round trip.
 */
function absPathErrors(value: DaemonModeFormValue): string[] {
  const errors: string[] = []
  const settings = value.settingsPath.trim()
  const mcp = value.mcpConfigPath.trim()
  if (settings && !settings.startsWith('/')) errors.push('Settings path must be absolute (start with /)')
  if (mcp && !mcp.startsWith('/')) errors.push('MCP config path must be absolute (start with /)')
  return errors
}

/**
 * Validate a NEW / RESUME config form. Returns a list of human-readable
 * errors; an empty list means the form is launchable.
 */
export function validateDaemonModeForm(mode: 'new' | 'resume', value: DaemonModeFormValue): string[] {
  const errors: string[] = []
  // NEW no longer requires a prompt: the cc-daemon socket dispatch supports
  // promptless launch (transport reframe Phase 4 -- spike P1). A prompt is
  // still accepted and forwarded as the first turn when supplied.
  if (mode === 'resume' && !value.resumeSessionId.trim()) {
    errors.push('Resume session id is required')
  }
  const [, envErrors] = parseEnvText(value.envText)
  errors.push(...envErrors)
  errors.push(...absPathErrors(value))
  return errors
}

/** Validate an ATTACH selection -- a roster worker's 8-hex short id. */
export function validateDaemonAttach(short: string | undefined): string[] {
  if (!short?.trim()) return ['Select a daemon worker to attach to']
  if (!/^[0-9a-f]{8}$/.test(short.trim())) return ['Selected worker has an invalid short id']
  return []
}

/** Inputs to `buildDaemonSpawnFields`. */
export interface DaemonSpawnInput {
  mode: DaemonMode
  /** NEW/RESUME config. Ignored for ATTACH. */
  form: DaemonModeFormValue
  /** ATTACH target -- the selected roster worker's 8-hex short. */
  attachShort?: string
}

const trimmed = (s: string): string | undefined => s.trim() || undefined

/** Drop undefined-valued keys so the opaque transportMeta bag stays minimal
 *  (and an `attach` bag never carries forbidden config keys). */
function compactMeta(meta: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Build the daemon-specific slice of a SpawnRequest for the given mode. The
 * spawn dialog merges this onto the common fields (cwd, name, sentinel, jobId).
 *
 * - ATTACH forwards ONLY the worker short -- no prompt, no config injection.
 * - NEW/RESUME forward the prompt + config (settings/mcp/sysprompt/env/model).
 * - RESUME additionally forwards the resume session id.
 *
 * Transport reframe (Phase 6 -- the delete phase): emits ONLY the canonical
 * `backend: 'claude'` + `transport: 'claude-daemon'` + `transportMeta` shape.
 * The daemon launch inputs (mode / attachShort / resumeSessionId / settingsPath
 * / mcpConfigPath / appendSystemPrompt) live in the opaque `transportMeta` bag;
 * the flat `daemon*` fields are gone. `prompt` / `model` / `env` / `worktree`
 * stay top-level (they are backend-general SpawnRequest fields).
 *
 * Callers validate via `validateDaemonModeForm` / `validateDaemonAttach` first;
 * this function does no validation, it only shapes the request.
 */
export function buildDaemonSpawnFields(input: DaemonSpawnInput): Partial<SpawnRequest> {
  const { mode, form, attachShort } = input
  if (mode === 'attach') {
    const short = attachShort?.trim() || undefined
    return {
      backend: 'claude',
      transport: 'claude-daemon',
      transportMeta: compactMeta({ mode: 'attach', attachShort: short }),
    }
  }
  const [env] = parseEnvText(form.envText)
  const settingsPath = trimmed(form.settingsPath)
  const mcpConfigPath = trimmed(form.mcpConfigPath)
  const appendSystemPrompt = trimmed(form.appendSystemPrompt)
  const resumeSessionId = mode === 'resume' ? trimmed(form.resumeSessionId) : undefined
  return {
    backend: 'claude',
    prompt: trimmed(form.prompt),
    model: trimmed(form.model) as SpawnRequest['model'],
    env: env ?? undefined,
    worktree: trimmed(form.worktreeName),
    transport: 'claude-daemon',
    transportMeta: compactMeta({ mode, settingsPath, mcpConfigPath, appendSystemPrompt, resumeSessionId }),
  }
}
