import type { ServerWebSocket } from 'bun'
import {
  type ClaudeEfficiencyUpdate,
  type ClaudeHealthUpdate,
  HEARTBEAT_INTERVAL_MS,
  type ProfileUsageSnapshot,
  type SelectionMode,
  type SentinelFeatures,
  type SentinelProfileInfo,
  type UsageUpdate,
} from '../../shared/protocol'
import type { ControlPanelMessage, SentinelStatusInfo } from './types'

const SENTINEL_DIAG_MAX = 200
const SENTINEL_STALE_MS = HEARTBEAT_INTERVAL_MS * 2.5

export function buildSentinelList(state: SentinelState): SentinelStatusInfo[] {
  const list: SentinelStatusInfo[] = []
  for (const conn of state.sentinels.values()) {
    list.push({
      sentinelId: conn.sentinelId,
      alias: conn.alias,
      hostname: conn.hostname,
      connected: true,
      profiles: conn.profiles,
      defaultSelection: conn.defaultSelection,
      pools: conn.pools,
      defaultPool: conn.defaultPool,
      shellCapable: conn.features?.shell ?? false,
    })
  }
  return list
}

export interface SentinelConnection {
  ws: ServerWebSocket<unknown>
  sentinelId: string
  alias: string
  hostname?: string
  machineId?: string
  spawnRoot?: string
  connectedAt: number
  lastHeartbeat: number
  /** Sentinel-reported profile NAMES + display metadata. Refreshed on every
   *  sentinel_identify. Lives in memory only -- the registry file does not
   *  persist profiles (profile config is sentinel-local; the broker rediscovers
   *  on reconnect). NEVER contains configDir / env -- Profile-Env Boundary. */
  profiles?: SentinelProfileInfo[]
  /** What the sentinel does on a no-profile spawn. */
  defaultSelection?: SelectionMode
  /** Distinct pool NAMES across `profiles` (sorted; excludes the `null` pool). */
  pools?: string[]
  /** Pool the sentinel uses when a Balanced/Random launch omits a pool.
   *  Defaults to `'default'`. */
  defaultPool?: string
  /** Latest per-profile usage snapshots reported by this sentinel.
   *  Keyed by `ProfileUsageSnapshot.profile`. Refreshed every poll cycle
   *  (default 3min). Cleared with the connection -- a disconnected sentinel
   *  has no live telemetry to show.
   *
   *  Profile NAMES + utilisation numbers only (Profile-Env Boundary).
   *  Used by:
   *   - the control panel's top usage bar (Phase 4)
   *   - the launch dialog's profile-radio inline mini-bars (Phase 5)
   *   - the sentinel's own Smart Balance picker (Phase 3, read from
   *     `getLatestProfileUsage` in `src/sentinel/index.ts` -- this map is the
   *     broker's mirror, sentinel still owns the source of truth) */
  profileUsage?: Map<string, ProfileUsageSnapshot>
  /** ms epoch of the most recent `sentinel_usage_report` from this sentinel. */
  profileUsagePolledAt?: number
  /** Host-level capabilities the sentinel advertised at registration (e.g.
   *  `shell`). Joined onto `ConversationSummary.shellCapable` per conversation
   *  via `hostSentinelId`. Refreshed on every `sentinel_identify`. */
  features?: SentinelFeatures
}

export interface SentinelIdentifyInfo {
  machineId?: string
  hostname?: string
  alias?: string
  spawnRoot?: string
  sentinelId?: string
  /** Reported profile NAMES + display only -- NEVER configDir or env. */
  profiles?: SentinelProfileInfo[]
  defaultSelection?: SelectionMode
  pools?: string[]
  defaultPool?: string
  /** Host-level capabilities (e.g. `shell`). Absent = no extra features. */
  features?: SentinelFeatures
}

export interface SentinelState {
  sentinels: Map<string, SentinelConnection> // sentinelId -> live connection
  sentinelsByAlias: Map<string, string> // alias -> sentinelId (O(1) alias lookup)
  diagLog: Array<{ t: number; type: string; msg: string; args?: unknown }>
  usage: UsageUpdate | undefined
  claudeHealth: ClaudeHealthUpdate | undefined
  claudeEfficiency: ClaudeEfficiencyUpdate | undefined
}

export function createSentinelState(): SentinelState {
  return {
    sentinels: new Map(),
    sentinelsByAlias: new Map(),
    diagLog: [],
    usage: undefined,
    claudeHealth: undefined,
    claudeEfficiency: undefined,
  }
}

export function setSentinel(
  state: SentinelState,
  ws: ServerWebSocket<unknown>,
  broadcast: (msg: ControlPanelMessage) => void,
  info?: SentinelIdentifyInfo,
): boolean {
  const sentinelId = info?.sentinelId || 'default'
  const alias = info?.alias || 'default'

  // Replace existing connection for this sentinel (reconnect case)
  const existing = state.sentinels.get(sentinelId)
  if (existing) {
    try {
      existing.ws.close(4409, 'Replaced by new connection')
    } catch {}
  }

  const now = Date.now()
  const conn: SentinelConnection = {
    ws,
    sentinelId,
    alias,
    hostname: info?.hostname,
    machineId: info?.machineId,
    spawnRoot: info?.spawnRoot,
    connectedAt: now,
    lastHeartbeat: now,
    profiles: info?.profiles,
    defaultSelection: info?.defaultSelection,
    pools: info?.pools,
    defaultPool: info?.defaultPool,
    features: info?.features,
  }
  state.sentinels.set(sentinelId, conn)
  state.sentinelsByAlias.set(alias, sentinelId)
  broadcast({
    type: 'sentinel_status',
    connected: true,
    machineId: info?.machineId,
    hostname: info?.hostname,
    sentinels: buildSentinelList(state),
  })
  return true
}

/**
 * Refresh a connected sentinel's stored profile registry from a post-patch
 * snapshot (the `applied` slice of a `sentinel_patch_config_ack`). Updates the
 * in-memory `SentinelConnection` profiles / pools / defaultSelection /
 * defaultPool and broadcasts a fresh `sentinel_status` so the control panel
 * reflects the change without waiting for the next `sentinel_identify`.
 *
 * NAMES + display + routing only -- the snapshot is the broker-safe slice; this
 * never sees configDir / env (Profile-Env Boundary). Returns `false` when the
 * sentinel is unknown (e.g. disconnected between sending the patch and the ack).
 */
export function applySentinelConfigSnapshot(
  state: SentinelState,
  sentinelId: string,
  snapshot: {
    profiles?: SentinelProfileInfo[]
    defaultSelection?: SelectionMode
    pools?: string[]
    defaultPool?: string
  },
  broadcast: (msg: ControlPanelMessage) => void,
): boolean {
  const conn = state.sentinels.get(sentinelId)
  if (!conn) return false
  if (snapshot.profiles !== undefined) conn.profiles = snapshot.profiles
  if (snapshot.defaultSelection !== undefined) conn.defaultSelection = snapshot.defaultSelection
  if (snapshot.pools !== undefined) conn.pools = snapshot.pools
  if (snapshot.defaultPool !== undefined) conn.defaultPool = snapshot.defaultPool
  broadcast({
    type: 'sentinel_status',
    connected: true,
    machineId: conn.machineId,
    hostname: conn.hostname,
    sentinels: buildSentinelList(state),
  })
  return true
}

export function removeSentinel(
  state: SentinelState,
  ws: ServerWebSocket<unknown>,
  broadcast: (msg: ControlPanelMessage) => void,
): void {
  for (const [id, conn] of state.sentinels) {
    if (conn.ws === ws) {
      state.sentinels.delete(id)
      state.sentinelsByAlias.delete(conn.alias)
      broadcast({
        type: 'sentinel_status',
        connected: state.sentinels.size > 0,
        sentinels: buildSentinelList(state),
      })
      return
    }
  }
}

export function recordSentinelHeartbeat(state: SentinelState, ws: ServerWebSocket<unknown>): void {
  for (const conn of state.sentinels.values()) {
    if (conn.ws === ws) {
      conn.lastHeartbeat = Date.now()
      return
    }
  }
}

export function isSentinelAlive(state: SentinelState, sentinelId: string): boolean {
  const conn = state.sentinels.get(sentinelId)
  if (!conn) return false
  return Date.now() - conn.lastHeartbeat < SENTINEL_STALE_MS
}

export function pushSentinelDiag(
  state: SentinelState,
  entry: { t: number; type: string; msg: string; args?: unknown },
): void {
  state.diagLog.push(entry)
  if (state.diagLog.length > SENTINEL_DIAG_MAX) {
    state.diagLog.splice(0, state.diagLog.length - SENTINEL_DIAG_MAX)
  }
}

export function setUsage(
  state: SentinelState,
  usage: UsageUpdate,
  broadcast: (msg: ControlPanelMessage) => void,
): void {
  state.usage = usage
  broadcast({ type: 'usage_update', usage } as unknown as ControlPanelMessage)
}

/**
 * Record a sentinel's batched per-profile usage report. Replaces the per-profile
 * snapshot map on the connection wholesale (every cycle covers every profile),
 * then broadcasts to the control panel so the top usage bar + launch-dialog
 * mini-bars can refresh.
 *
 * Returns `false` (no-op) when the sentinel is unknown -- this happens for
 * legacy shared-secret sentinels whose connection wasn't promoted yet.
 */
export function setSentinelProfileUsage(
  state: SentinelState,
  ws: ServerWebSocket<unknown>,
  profiles: ProfileUsageSnapshot[],
  polledAt: number,
  broadcast: (msg: ControlPanelMessage) => void,
): boolean {
  for (const conn of state.sentinels.values()) {
    if (conn.ws !== ws) continue
    const map = new Map<string, ProfileUsageSnapshot>()
    for (const snap of profiles) map.set(snap.profile, snap)
    conn.profileUsage = map
    conn.profileUsagePolledAt = polledAt
    broadcast({
      type: 'sentinel_usage_report',
      sentinelId: conn.sentinelId,
      profileUsage: profiles,
      polledAt,
    })
    return true
  }
  return false
}

/** Read-only view of a sentinel's latest per-profile usage. Returns `undefined`
 *  when the sentinel is offline or hasn't reported yet. */
export function getSentinelProfileUsage(
  state: SentinelState,
  sentinelId: string,
): { profiles: ProfileUsageSnapshot[]; polledAt: number } | undefined {
  const conn = state.sentinels.get(sentinelId)
  if (!conn?.profileUsage || conn.profileUsagePolledAt === undefined) return undefined
  return {
    profiles: [...conn.profileUsage.values()].sort((a, b) => a.profile.localeCompare(b.profile)),
    polledAt: conn.profileUsagePolledAt,
  }
}

export function setClaudeHealth(
  state: SentinelState,
  health: ClaudeHealthUpdate,
  broadcast: (msg: ControlPanelMessage) => void,
): void {
  state.claudeHealth = health
  broadcast(health as unknown as ControlPanelMessage)
}

export function setClaudeEfficiency(
  state: SentinelState,
  efficiency: ClaudeEfficiencyUpdate,
  broadcast: (msg: ControlPanelMessage) => void,
): void {
  state.claudeEfficiency = efficiency
  broadcast(efficiency as unknown as ControlPanelMessage)
}
