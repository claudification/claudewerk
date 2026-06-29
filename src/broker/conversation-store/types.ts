import type {
  ClaudeEfficiencyUpdate,
  ClaudeHealthUpdate,
  ConversationSummary,
  LaunchProfile,
  ProfileUsageSnapshot,
  SelectionMode,
  SentinelProfileInfo,
  TerminationDetail,
  TerminationSource,
} from '../../shared/protocol'

export type { ConversationSummary }

export interface SentinelStatusInfo {
  sentinelId: string
  alias: string
  hostname?: string
  connected: boolean
  isDefault?: boolean
  color?: string
  /** Sentinel-reported profile NAMES + display only (Profile-Env Boundary).
   *  Only present when the sentinel is connected AND reported a non-empty
   *  profiles list. Consumed by the control panel for profile pickers /
   *  badges. NEVER contains `configDir` or `env`. */
  profiles?: SentinelProfileInfo[]
  /** What this sentinel does on a no-profile spawn (`default` | `balanced` |
   *  `random`). Read-only display; configured via the sentinel CLI. */
  defaultSelection?: SelectionMode
  /** Distinct pool NAMES across `profiles` (sorted; excludes the null pool).
   *  Used by the launch dialog's pool picker. */
  pools?: string[]
  /** Pool the sentinel uses for Balanced/Random when the launch omits a pool.
   *  Defaults to `'default'`. */
  defaultPool?: string
  /** Sentinel advertises `features.shell` -- a host shell can be opened on any
   *  project this sentinel owns, WITHOUT a conversation. Sourced from the
   *  sentinel's reported `features.shell`; the host shell is a SENTINEL feature,
   *  not an agent-host one. Lets the control panel offer "open terminal" on a
   *  project view that has no live conversation. */
  shellCapable?: boolean
}

export interface ControlPanelMessage {
  type:
    | 'conversation_update'
    | 'conversation_patch'
    | 'conversation_created'
    | 'conversation_ended'
    | 'conversation_terminated'
    | 'event'
    | 'conversations_list'
    | 'sentinel_status'
    | 'toast'
    | 'settings_updated'
    | 'project_settings_updated'
    | 'clipboard_capture'
    | 'usage_update'
    | 'sentinel_usage_report'
    | 'profile_auth_trouble'
    | 'claude_health_update'
    | 'claude_efficiency_update'
    | 'launch_profiles_updated'
    // Observability events (LOG EVERYTHING covenant)
    | 'conversation_status_transition'
    | 'socket_replaced'
    | 'phantom_reap_candidate'
    // Live per-message token sample (powers the token-flow widget)
    | 'token_sample'
    // Inter-conversation send observed (powers THE CANVAS message pulses).
    // Scoped to the SENDER's project -- chat:read there already exposes the
    // send + target id via the sender's transcript, so this leaks nothing new.
    | 'inter_conversation_activity'
  conversationId?: string
  previousConversationId?: string
  conversation?: ConversationSummary
  conversations?: ConversationSummary[]
  diffs?: unknown[]
  event?: unknown
  connected?: boolean
  machineId?: string
  hostname?: string
  sentinels?: SentinelStatusInfo[]
  title?: string
  message?: string
  settings?: unknown
  claudeHealth?: ClaudeHealthUpdate
  claudeEfficiency?: ClaudeEfficiencyUpdate
  userName?: string
  launchProfiles?: LaunchProfile[]
  // Per-sentinel profile usage broadcast (sentinel_usage_report).
  // sentinelId is stamped by the broker; profileUsage carries one entry
  // per profile the sentinel knows about. Polled-at lives on each entry.
  sentinelId?: string
  profileUsage?: ProfileUsageSnapshot[]
  polledAt?: number
  // Inter-conversation activity (inter_conversation_activity): conversationId
  // above carries the SENDER (doubles as the share-scope key); status reuses
  // the shared field ('delivered' | 'queued'); `at` is the broker send time.
  toConversationId?: string
  intent?: string
  // Termination metadata (only on conversation_terminated)
  source?: TerminationSource | string
  initiator?: string
  detail?: TerminationDetail
  endedAt?: number
  // Observability event fields (status transition, socket replace, reap candidate)
  from?: string
  to?: string
  reason?: string
  liveSockets?: number
  ccSessionId?: string
  lastActivityAgoMs?: number
  at?: number
  connectionId?: string
  oldReadyState?: number
  oldBufferedAmount?: number
  newReadyState?: number
  via?: string
  status?: string
  willEnd?: boolean
  // Live token sample (token_sample). Raw PER-MESSAGE usage for the token-flow
  // widget. conversationId + sentinelId reuse the fields above. timestamp is the
  // assistant message time; profile/model identify the series; the four token
  // counts are this single API response (NOT cumulative).
  timestamp?: number
  profile?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
