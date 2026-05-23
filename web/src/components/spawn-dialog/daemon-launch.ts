/**
 * daemon-launch -- pure helpers for the spawn dialog's Daemon backend.
 *
 * Three launch modes ride a single `daemonMode` discriminator (plan
 * `.claude/docs/plan-daemon-launch-ux.md` Section 2):
 *   - new:    `claude --bg "<prompt>"`              -- prompt required
 *   - resume: `claude --bg --resume <sessionId>`    -- resume session id required
 *   - attach: attach to a roster worker (no --bg)   -- 8-hex short required
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
  if (mode === 'new' && !value.prompt.trim()) {
    errors.push('Prompt is required for a new daemon worker')
  }
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
  if (!short || !short.trim()) return ['Select a daemon worker to attach to']
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
 * DUAL-WRITE (transport reframe Phase 1): populates BOTH the new canonical
 * `transport: 'claude-daemon'` + `transportMeta` bag AND the legacy flat
 * `daemon*` fields. The schema validates either; the broker prefers the new
 * shape (backends/daemon.ts dual-reads transportMeta). Phase 5 drops the
 * legacy fields here.
 *
 * Callers validate via `validateDaemonModeForm` / `validateDaemonAttach` first;
 * this function does no validation, it only shapes the request.
 */
export function buildDaemonSpawnFields(input: DaemonSpawnInput): Partial<SpawnRequest> {
  const { mode, form, attachShort } = input
  if (mode === 'attach') {
    const short = attachShort?.trim() || undefined
    return {
      backend: 'daemon',
      daemonMode: 'attach',
      daemonAttachShort: short,
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
    backend: 'daemon',
    daemonMode: mode,
    prompt: trimmed(form.prompt),
    model: trimmed(form.model) as SpawnRequest['model'],
    appendSystemPrompt,
    env: env ?? undefined,
    daemonSettingsPath: settingsPath,
    daemonMcpConfigPath: mcpConfigPath,
    worktree: trimmed(form.worktreeName),
    daemonResumeSessionId: resumeSessionId,
    transport: 'claude-daemon',
    transportMeta: compactMeta({ mode, settingsPath, mcpConfigPath, appendSystemPrompt, resumeSessionId }),
  }
}
