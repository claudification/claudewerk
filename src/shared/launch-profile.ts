/**
 * Launch Profile -- a named bundle of spawn defaults the user can fire
 * via chord (Cmd+J) or palette or the spawn dialog dropdown.
 *
 * Consumers:
 * - Broker storage:  src/broker/launch-profiles/
 * - HTTP routes:     src/broker/launch-profiles/routes.ts
 * - Spawn resolver:  src/shared/spawn-defaults.ts (profile tier)
 * - Control panel:   web/src/components/launch-profiles/
 */

import { z } from 'zod'
import { spawnRequestSchema } from './spawn-schema'

export const LAUNCH_PROFILE_ID_PREFIX = 'lp_'
export const LAUNCH_PROFILE_MAX_APPEND_SP = 16 * 1024
export const LAUNCH_PROFILE_MAX_COUNT = 50

const MAX_NAME = 64
const MAX_SHORT_LABEL = 24

// Backends whose spawn path honors `--append-system-prompt`. The claude backend
// covers all three transports (pty / headless / claude-daemon): spike 2 (plan
// Section 8) live-verified the daemon worker applies `--append-system-prompt`.
export const BACKENDS_WITH_APPEND_SYSTEM_PROMPT = ['claude', 'chat-api'] as const

export function backendSupportsAppendSystemPrompt(backend: string | undefined): boolean {
  if (!backend) return true
  return (BACKENDS_WITH_APPEND_SYSTEM_PROMPT as readonly string[]).includes(backend)
}

const PROFILE_COLOR_OPTIONS = ['primary', 'success', 'warning', 'destructive', 'info', 'muted'] as const

// A profile carries reusable spawn DEFAULTS, never per-launch identifiers.
// `cwd` / `jobId` are resolved at launch. Daemon profiles persist `transport:
// 'claude-daemon'` + a `transportMeta` slice ({ mode, settingsPath, ... }); the
// editor only ever writes `mode: 'new' | 'resume'` (the attach target + the
// resume-from session id are ephemeral per-launch targets, not profile data).
const profileSpawnSchema = spawnRequestSchema
  .omit({ cwd: true, jobId: true })
  .extend({
    appendSystemPrompt: z.string().max(LAUNCH_PROFILE_MAX_APPEND_SP, 'appendSystemPrompt exceeds 16 KB cap').optional(),
  })
  .partial()

export const launchProfileSchema = z.object({
  id: z.string().startsWith(LAUNCH_PROFILE_ID_PREFIX),
  name: z.string().min(1, 'name is required').max(MAX_NAME),
  shortLabel: z.string().max(MAX_SHORT_LABEL).optional(),
  icon: z.string().max(64).optional(),
  color: z.enum(PROFILE_COLOR_OPTIONS).optional(),
  order: z.number().int().optional(),

  chord: z.string().max(32).optional(),
  immediate: z.boolean().optional(),

  sentinel: z.string().max(128).optional(),
  project: z.string().max(2048).optional(),

  spawn: profileSpawnSchema,

  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),

  lastUsedAt: z.number().int().nonnegative().optional(),
  useCount: z.number().int().nonnegative().optional(),
})
export type LaunchProfile = z.infer<typeof launchProfileSchema>

export const launchProfileListSchema = z
  .array(launchProfileSchema)
  .max(LAUNCH_PROFILE_MAX_COUNT, `at most ${LAUNCH_PROFILE_MAX_COUNT} profiles`)

/**
 * Migrate stored launch profiles from the legacy daemon shape (transport
 * reframe Phase 6), mirroring `migrateLegacyDefaultBackend` for global settings.
 * A profile saved with `spawn.backend:'daemon'` + flat `daemon*` fields is
 * rewritten to the canonical `spawn.backend:'claude'` + `transport:'claude-daemon'`,
 * moving the injected paths onto the web-readable backend-general `settingsPath`
 * / `mcpConfigPath` fields and dropping the removed flat fields + the daemon mode
 * (a profile is always NEW-mode -- resume/attach are per-launch only). Keyed on
 * the legacy `backend:'daemon'` marker so already-migrated profiles pass through
 * untouched. Pure -- operates on the raw blob BEFORE any schema parse (a stored
 * `backend:'daemon'` no longer parses, so the rewrite must happen at the read
 * boundary). Never READS the opaque `transportMeta` bag (boundary rule).
 */
export function migrateLegacyDaemonProfiles(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.map(profile => {
    if (typeof profile !== 'object' || profile === null) return profile
    const p = profile as Record<string, unknown>
    const spawn = p.spawn
    if (typeof spawn !== 'object' || spawn === null) return profile
    const s = spawn as Record<string, unknown>
    if (s.backend !== 'daemon') return profile
    const {
      backend: _backend,
      daemonMode: _mode,
      daemonSettingsPath,
      daemonMcpConfigPath,
      daemonResumeSessionId: _resume,
      daemonAttachShort: _attach,
      ...restSpawn
    } = s
    const next: Record<string, unknown> = { ...restSpawn, backend: 'claude', transport: 'claude-daemon' }
    if (typeof daemonSettingsPath === 'string') next.settingsPath = daemonSettingsPath
    if (typeof daemonMcpConfigPath === 'string') next.mcpConfigPath = daemonMcpConfigPath
    return { ...p, spawn: next }
  })
}

export function newLaunchProfileId(): string {
  // Web Crypto global -- works in both the browser and Bun. `node:crypto`
  // does NOT survive bundling for the control panel (the polyfill has no
  // randomUUID export), and this module is shared with web/.
  return `${LAUNCH_PROFILE_ID_PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function isLaunchProfileId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.startsWith(LAUNCH_PROFILE_ID_PREFIX) && id.length > LAUNCH_PROFILE_ID_PREFIX.length
  )
}
