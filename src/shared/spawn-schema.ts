/**
 * Single source of truth for spawn requests.
 *
 * Consumers:
 * - HTTP route: src/broker/routes.ts (/api/spawn)
 * - MCP tool: src/agent-host-common/mcp-host/mcp-channel.ts (spawn_session)
 * - Dashboard: web/src/components/spawn-dialog.tsx
 * - Dashboard: web/src/components/project-board.tsx (RunTaskDialog)
 */

import { z } from 'zod'
import { ALL_CC_SLUGS, DROPDOWN_MODEL_ENTRIES, resolveModelFamily } from './models'

export const DEFAULT_SENTINEL = '__default__'

type ModelOption = { value: string; label: string; info: string }
export type ModelOptionGroup = { group: string; options: ModelOption[] }

export const MODEL_OPTION_GROUPS: ModelOptionGroup[] = (() => {
  const current: ModelOption[] = []
  const previous: ModelOption[] = []
  const legacy: ModelOption[] = []

  for (const m of DROPDOWN_MODEL_ENTRIES) {
    const opt = { value: m.id, label: m.label, info: m.info }
    // Group by the registry's `tier` field (models.ts) -- no id regexes.
    const tier = resolveModelFamily(m.id)?.tier ?? 'current'
    if (tier === 'legacy') legacy.push(opt)
    else if (tier === 'previous') previous.push(opt)
    else current.push(opt)
  }

  const groups: ModelOptionGroup[] = [{ group: 'Current', options: current }]
  if (previous.length > 0) groups.push({ group: 'Previous', options: previous })
  if (legacy.length > 0) groups.push({ group: 'Legacy', options: legacy })
  return groups
})()

/** Flat list for backwards compat -- includes Default sentinel. */
const _MODEL_OPTIONS = [
  { value: DEFAULT_SENTINEL, label: 'Default', info: 'Use project / global default' },
  ...DROPDOWN_MODEL_ENTRIES.map(m => ({ value: m.id, label: m.label, info: m.info })),
] as const

export const EFFORT_OPTIONS = [
  { value: DEFAULT_SENTINEL, label: 'Default', info: 'Use project / global default' },
  { value: 'low', label: 'Low', info: 'Minimal thinking budget' },
  { value: 'medium', label: 'Medium', info: 'Moderate thinking' },
  { value: 'high', label: 'High', info: 'Deep thinking (slower)' },
  { value: 'xhigh', label: 'XHigh', info: 'Extended deep thinking' },
  { value: 'max', label: 'Max', info: 'Maximum thinking budget' },
] as const

export const OPENCODE_TOOL_PERMISSION_OPTIONS = [
  { value: 'safe', label: 'Safe', info: 'Read-only tools (read, glob, grep, ls, webfetch); no bash/write/edit' },
  { value: 'none', label: 'None', info: 'Pure chat -- no tools at all' },
  {
    value: 'full',
    label: 'Full (dangerous)',
    info: 'All tools incl. bash + write + edit; --dangerously-skip-permissions',
  },
] as const

export type OpenCodeToolPermission = (typeof OPENCODE_TOOL_PERMISSION_OPTIONS)[number]['value']

export const PERMISSION_MODE_OPTIONS = [
  { value: DEFAULT_SENTINEL, label: 'Default', info: 'CC default prompting behaviour' },
  { value: 'plan', label: 'Plan', info: 'Plan-first mode' },
  { value: 'acceptEdits', label: 'Accept Edits', info: 'Auto-accept file edits' },
  { value: 'auto', label: 'Auto', info: 'Auto-approve most tools' },
  { value: 'bypassPermissions', label: 'Bypass', info: 'Skip permission prompts (dangerous)' },
] as const

// Keep TIMEOUT_OPTIONS simple; used only by RunTaskDialog today
const _TIMEOUT_OPTIONS = [
  { value: '5', label: '5 min' },
  { value: '10', label: '10 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '0', label: 'No timeout' },
] as const

// Accept any slug CC recognizes. The full list lives in CC_MODELS (models.ts).
// dispatchSpawn does the real validation with a helpful error listing valid models.
const modelEnum = z.enum(ALL_CC_SLUGS as unknown as [string, ...string[]])
const effortEnum = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
const permissionModeEnum = z.enum(['plan', 'acceptEdits', 'auto', 'bypassPermissions'])
const spawnModeEnum = z.enum(['fresh', 'resume'])

// Transports per backend (the wire mechanism used to drive a member of the
// backend family). Fully qualified with the backend they belong to so the
// discriminator never collides when other backends grow their own transports.
// See `.claude/docs/plan-claude-transport-reframe.md` § 0.1 / 0.2. Only the
// three `claude-*` values are valid in this plan; future backends add their own.
export const transportEnum = z.enum(['claude-pty', 'claude-headless', 'claude-daemon'])

export const spawnRequestSchema = z.object({
  cwd: z
    .string()
    .min(1, 'cwd is required')
    .describe(
      'Working directory. Absolute (/…), ~-relative (~/…), or relative — relative paths resolve against agent spawnRoot ($HOME by default).',
    ),
  mkdir: z.boolean().optional().describe('Create cwd if it does not exist'),
  mode: spawnModeEnum.optional().describe('"fresh" (default) or "resume" to resume a specific CC session'),
  resumeId: z.string().optional().describe('Claude Code session ID to resume when mode=resume'),
  headless: z
    .boolean()
    .optional()
    .describe(
      'stream-json mode. Default: true. Do NOT set to false unless the user explicitly requests a PTY/interactive session.',
    ),
  bare: z.boolean().optional().describe('Launch without injecting hooks'),
  repl: z.boolean().optional().describe('Launch CC in REPL mode'),
  name: z.string().optional().describe('Display label in sidebar'),
  description: z
    .string()
    .optional()
    .describe('Short description of what this conversation is about. Shown in dashboard and list_conversations.'),
  model: modelEnum
    .optional()
    .describe('Model override. Omit to use project/global default. Only set when a specific model is requested.'),
  effort: effortEnum.optional().describe('Thinking effort budget'),
  permissionMode: permissionModeEnum.optional().describe('CC permission prompting mode'),
  autocompactPct: z.number().min(0).max(100).optional().describe('Auto-compact threshold (%)'),
  maxBudgetUsd: z
    .number()
    .positive()
    .optional()
    .describe(
      'Max spend in USD before auto-stop. NEVER set this unless the user explicitly asks to cap or set a budget. Omit by default - the project/global default applies.',
    ),
  includePartialMessages: z
    .boolean()
    .optional()
    .describe('Include partial message chunks (token streaming). Default: true for normal, false for ad-hoc'),
  agent: z.string().optional().describe('Agent name (passed as --agent to claude CLI)'),
  worktree: z.string().optional().describe('Branch name - creates isolated git worktree'),
  env: z.record(z.string(), z.string()).optional().describe('Env var overrides'),
  prompt: z.string().optional().describe('Initial prompt (headless only)'),
  adHoc: z.boolean().optional().describe('Mark as ad-hoc task runner session'),
  adHocTaskId: z.string().optional().describe('Project task slug when adHoc=true'),
  leaveRunning: z
    .boolean()
    .optional()
    .describe('Keep session running after prompt completes (only applies when adHoc=true, ignored otherwise)'),
  sentinel: z.string().optional().describe('Target sentinel alias for spawn routing. Default sentinel if omitted.'),
  jobId: z.string().uuid().optional().describe('Caller-supplied job id for progress correlation'),
  backend: z
    .enum(['claude', 'chat-api', 'hermes', 'opencode'])
    .optional()
    .describe(
      'Agent backend (the agent family). Default: claude. "chat-api" for generic chat, "hermes" for Hermes gateway, ' +
        '"opencode" for OpenCode (multi-provider tool-using agent). The daemon is NOT a backend -- it is the claude ' +
        'backend\'s "claude-daemon" transport (set `transport`).',
    ),
  chatConnectionId: z.string().optional().describe('Chat API connection ID (required when backend=chat-api)'),
  chatConnectionName: z.string().optional().describe('Chat API connection display name (for project URI)'),
  gatewayId: z
    .string()
    .optional()
    .describe(
      'Hermes gateway ID (required when backend=hermes and multiple gateways are connected; auto-picked when only one is available)',
    ),
  openCodeModel: z
    .string()
    .optional()
    .describe(
      'OpenCode model (any string in OpenCode\'s provider/model format, e.g. "openrouter/anthropic/claude-haiku-4.5"). Used when backend=opencode.',
    ),
  toolPermission: z
    .enum(['none', 'safe', 'full'])
    .optional()
    .describe(
      'OpenCode tool permission tier. "none" disables every tool (pure chat). "safe" (default) allows read-only tools (read, glob, grep, ls, webfetch); bash/write/edit are denied. "full" allows everything via --dangerously-skip-permissions. Used when backend=opencode.',
    ),
  appendSystemPrompt: z
    .string()
    .max(16 * 1024)
    .optional()
    .describe(
      'Appended to the generated system prompt. CC maps this to --append-system-prompt; chat-api prepends a system message. Ignored by backends that cannot honor it (hermes, opencode).',
    ),
  transport: transportEnum
    .optional()
    .describe(
      'Wire mechanism for the claude backend (the canonical activation discriminator). Defaults are applied by ' +
        'resolveSpawnConfig per backend. "claude-pty" interactive terminal, "claude-headless" stream-json over ' +
        'stdin, "claude-daemon" cc-daemon socket worker (subscription-billed). Daemon-specific launch inputs ' +
        '(mode / attachShort / resumeSessionId / settingsPath / mcpConfigPath) live in `transportMeta`.',
    ),
  transportMeta: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Backend-specific opaque bag (parallel to agentHostMeta). The broker core passes it through wholesale; ' +
        'do NOT type or branch on its contents outside a backend implementation. ' +
        'claude-daemon keys: mode ("new"|"resume"|"attach"), attachShort (8-hex, attach), resumeSessionId (resume), ' +
        'settingsPath / mcpConfigPath / appendSystemPrompt (new|resume only). See plan-claude-transport-reframe.md § 0.3.',
    ),
  settingsPath: z
    .string()
    .optional()
    .describe(
      'Absolute path to a settings JSON. Backend-general (promoted from daemonSettingsPath): honored by backends ' +
        'that accept --settings (claude across all transports). Wired into PTY/headless in Phase 2.',
    ),
  mcpConfigPath: z
    .string()
    .optional()
    .describe(
      'Absolute path to an MCP config JSON. Backend-general (promoted from daemonMcpConfigPath): honored by backends ' +
        'that accept --mcp-config (claude across all transports). Wired into PTY/headless in Phase 2.',
    ),
  profile: z
    .string()
    .min(1)
    .max(63)
    .optional()
    .describe(
      'Sentinel-profile selection. Either a literal profile name (Fixed mode, e.g. "work") or a SelectionMode ' +
        'token ("default" | "balanced" | "random"). When absent, the sentinel applies its defaultSelection ' +
        '(typically the implicit "default" profile = $HOME/.claude). Profile env (configDir, API keys) is ' +
        'resolved sentinel-side; the broker never holds it.',
    ),
  pool: z
    .string()
    .regex(/^[a-z0-9-]{1,63}$/, 'pool must match [a-z0-9-]{1,63}')
    .optional()
    .describe(
      'Named profile pool for Balanced/Random selection (e.g. "work"). Used together with profile=' +
        '"balanced"|"random" to constrain which profiles the sentinel picks from. Ignored when profile is a ' +
        'literal name (Fixed mode wins) or "default". When absent the sentinel substitutes its configured ' +
        '`defaultPool` (which itself defaults to "default").',
    ),
})
export type SpawnRequest = z.infer<typeof spawnRequestSchema>

/** The fields `refineTransportSpawn` inspects. `transportMeta` is the opaque
 *  bag; the daemon transport's cross-field rules read its string keys. A
 *  structural subset so `.omit()` callers can re-apply the refinement. */
export type TransportSpawnFields = Pick<SpawnRequest, 'transport' | 'transportMeta' | 'prompt'>

/** Read a string-valued key from the opaque `transportMeta` bag, else undefined. */
function transportMetaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Cross-field validation for the NEW `transport` + `transportMeta` shape,
 * mirroring `refineDaemonSpawn` keyed on the canonical discriminator. Fires
 * ONLY for `transport === 'claude-daemon'`; the other transports (claude-pty,
 * claude-headless) carry no sub-mode and need no cross-field check. A no-op for
 * legacy requests that set no `transport`.
 *
 * Rules (plan-claude-transport-reframe.md § 2.1): mode defaults to 'new';
 * new -> NO required field (promptless NEW dispatch is supported -- Phase 4
 * socket dispatch P1 proved promptless `launch.args:[]` works, and Phase 5
 * relabeled the UI prompt "(optional)"; a daemon worker can boot idle and take
 * its first turn via a later `reply`); resume -> `transportMeta.resumeSessionId`
 * required; attach -> `transportMeta.attachShort` required AND config injection
 * (settingsPath / mcpConfigPath / appendSystemPrompt) forbidden (ATTACH takes
 * over an already-configured worker). `attachShort`, when present, must be 8-hex.
 */
/** RESUME requires the session to fork from. */
function refineDaemonResume(meta: Record<string, unknown> | undefined, ctx: z.RefinementCtx): void {
  if (transportMetaString(meta, 'resumeSessionId')?.trim()) return
  ctx.addIssue({
    code: 'custom',
    message: 'claude-daemon spawn (resume mode) requires transportMeta.resumeSessionId',
    path: ['transportMeta', 'resumeSessionId'],
  })
}

/** ATTACH requires the roster short AND forbids config injection (the worker is already configured). */
function refineDaemonAttach(meta: Record<string, unknown> | undefined, ctx: z.RefinementCtx): void {
  if (!transportMetaString(meta, 'attachShort')?.trim()) {
    ctx.addIssue({
      code: 'custom',
      message: 'claude-daemon spawn (attach mode) requires transportMeta.attachShort',
      path: ['transportMeta', 'attachShort'],
    })
  }
  for (const key of ['settingsPath', 'mcpConfigPath', 'appendSystemPrompt'] as const) {
    if (!transportMetaString(meta, key)) continue
    ctx.addIssue({
      code: 'custom',
      message: `claude-daemon attach must not set transportMeta.${key} (the worker is already configured)`,
      path: ['transportMeta', key],
    })
  }
}

/** `attachShort`, whenever present, must be an 8-hex daemon worker short id. */
function refineAttachShortFormat(meta: Record<string, unknown> | undefined, ctx: z.RefinementCtx): void {
  const short = transportMetaString(meta, 'attachShort')
  if (short === undefined || /^[0-9a-f]{8}$/.test(short)) return
  ctx.addIssue({
    code: 'custom',
    message: 'transportMeta.attachShort must be an 8-hex daemon worker short id',
    path: ['transportMeta', 'attachShort'],
  })
}

export function refineTransportSpawn(req: TransportSpawnFields, ctx: z.RefinementCtx): void {
  if (req.transport !== 'claude-daemon') return
  const meta = req.transportMeta
  const mode = transportMetaString(meta, 'mode') ?? 'new'
  // NEW mode requires nothing -- promptless NEW is intended (Phase 4 + Phase 5).
  if (mode === 'resume') refineDaemonResume(meta, ctx)
  if (mode === 'attach') refineDaemonAttach(meta, ctx)
  refineAttachShortFormat(meta, ctx)
}

/**
 * The schema spawn ENTRY POINTS validate against: the base object plus the
 * transport cross-field rules. Use this in routes/handlers. Use the bare
 * `spawnRequestSchema` object only when you need `.omit()`/`.extend()`/
 * `.partial()` (those are ZodObject methods this refined schema lacks).
 */
export const validatedSpawnRequestSchema = spawnRequestSchema.superRefine(refineTransportSpawn)
