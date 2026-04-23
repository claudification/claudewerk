import type { ServerWebSocket } from 'bun'
import type { UsageUpdate } from '../../shared/protocol'
import type { DashboardMessage } from './types'

const SENTINEL_DIAG_MAX = 200

export interface SentinelState {
  socket: ServerWebSocket<unknown> | undefined
  info: { machineId?: string; hostname?: string } | undefined
  diagLog: Array<{ t: number; type: string; msg: string; args?: unknown }>
  usage: UsageUpdate | undefined
}

export function createSentinelState(): SentinelState {
  return {
    socket: undefined,
    info: undefined,
    diagLog: [],
    usage: undefined,
  }
}

export function setSentinel(
  state: SentinelState,
  ws: ServerWebSocket<unknown>,
  broadcast: (msg: DashboardMessage) => void,
  info?: { machineId?: string; hostname?: string },
): boolean {
  if (state.socket) return false
  state.socket = ws
  state.info = info
  broadcast({ type: 'sentinel_status', connected: true, machineId: info?.machineId, hostname: info?.hostname })
  return true
}

export function removeSentinel(
  state: SentinelState,
  ws: ServerWebSocket<unknown>,
  broadcast: (msg: DashboardMessage) => void,
): void {
  if (state.socket === ws) {
    state.socket = undefined
    state.info = undefined
    broadcast({ type: 'sentinel_status', connected: false })
  }
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

export function setUsage(state: SentinelState, usage: UsageUpdate, broadcast: (msg: DashboardMessage) => void): void {
  state.usage = usage
  broadcast({ type: 'usage_update', usage } as unknown as DashboardMessage)
}
