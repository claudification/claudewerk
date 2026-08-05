/**
 * Wire key -> canonical kind. THE translation layer: every backend dialect enters here and
 * leaves as vocabulary the renderer understands.
 *
 * A wire key is `system/<subtype>` for a `type: "system"` entry, or the bare `type` for a
 * top-level one. Two different wire keys mapping to one kind is the point, not an accident:
 * Claude Code reports a published PR as `system/code_change_published` mid-stream and as a
 * `pr-link` entry in its JSONL, and the chat-api backend reports a request failure as
 * `chat_api_error` where CC says `api_error`. One kind, one describer, one line.
 *
 * Adding a backend means adding rows here -- never a new branch in the renderer.
 */

/** Wire key for an entry: `system/<subtype>`, or the bare top-level `type`. */
export function wireKey(entry: { type?: unknown; subtype?: unknown }): string {
  const type = typeof entry.type === 'string' ? entry.type : ''
  if (type !== 'system') return type
  const sub = typeof entry.subtype === 'string' ? entry.subtype : ''
  return sub ? `system/${sub}` : 'system'
}

/**
 * Claude Code's `type: "system"` subtypes. Sourced from the CLI's own zod schemas
 * (2.1.221) plus the subtypes rclaude synthesizes into the same channel.
 */
const CC_SYSTEM: Record<string, string> = {
  // request / model lane
  api_error: 'api-error',
  chat_api_error: 'api-error', // chat-api + ACP + opencode backends
  api_retry: 'api-retry',
  rate_limit: 'rate-limit', // rclaude-synthesized
  control_request_progress: 'api-retry',
  model_fallback: 'model-fallback',
  model_consent_fallback: 'model-consent',
  model_refusal_fallback: 'model-refusal',
  model_refusal_no_fallback: 'model-refusal-final',
  model_mismatch: 'model-mismatch', // rclaude-synthesized
  mirror_error: 'mirror-error',

  // conversation lane
  local_command: 'command-input',
  local_command_output: 'command-output',
  informational: 'info',
  notification: 'notification',
  compact_boundary: 'compacted',
  session_state_changed: 'conversation-state',
  turn_duration: 'turn-duration',
  stop_hook_summary: 'turn-stop',
  scheduled_task_fire: 'scheduled-fire',
  thinking: 'thinking-text',
  away_summary: 'recap',

  // capability / state lane
  memory_saved: 'memory-saved',
  memory_recall: 'memory-recall',
  files_persisted: 'files-saved',
  agents_killed: 'agents-killed',
  permission_retry: 'permission-allowed',
  permission_denied: 'permission-denied',
  plugin_install: 'plugin-install',
  elicitation_complete: 'elicitation-done',
  worker_shutting_down: 'worker-shutdown',

  // task / hook lane
  task_notification: 'task-status',
  task_progress: 'task-progress',
  task_updated: 'task-updated',
  hook_progress: 'hook-ran',
  hook_response: 'hook-failed',
  hook_feedback: 'hook-feedback', // synthesized by the grouper from a CC user entry
  background_tasks_changed: 'bg-tasks',

  // vcs lane
  vcs_state_changed: 'vcs-changed',
  code_change_published: 'code-published',

  // seen, deliberately silent
  status: 'heartbeat',
  file_snapshot: 'snapshot',
  post_turn_summary: 'post-turn-summary',
  task_started: 'task-started',
  task_summary: 'task-summary',
  hook_started: 'hook-started',
  thinking_tokens: 'thinking-tokens',
  commands_changed: 'commands-list',
  init: 'session-init',
}

/**
 * Top-level entry types. These come off the JSONL rather than the stdout stream, and until
 * now every one of them was dropped on the floor by the grouper (`process-entry.ts` returns
 * on anything that is not user/assistant/known), so they were stored and invisible.
 */
const TOP_LEVEL: Record<string, string> = {
  'pr-link': 'code-published',
  'worktree-state': 'worktree-entered',
  relocated: 'cwd-relocated',
  mode: 'mode-changed',
  'permission-mode': 'permission-mode-changed',

  // seen, deliberately silent -- high-volume metadata with no timeline meaning
  'file-history-snapshot': 'snapshot',
  'custom-title': 'title-set',
  'ai-title': 'title-set',
  'agent-name': 'agent-named',
  'agent-setting': 'agent-setting',
  attachment: 'attachment',
  'last-prompt': 'prompt-echo',
}

const KEY_TO_KIND: Record<string, string> = {
  ...TOP_LEVEL,
  ...Object.fromEntries(Object.entries(CC_SYSTEM).map(([sub, kind]) => [`system/${sub}`, kind])),
}

/** Canonical kind for an entry, or null when no backend dialect claims this wire key. */
export function kindOf(entry: { type?: unknown; subtype?: unknown }): string | null {
  return KEY_TO_KIND[wireKey(entry)] ?? null
}

/** Every wire key we translate -- the tests walk this to prove no kind is describer-less. */
export const WIRE_KEYS: string[] = Object.keys(KEY_TO_KIND)
