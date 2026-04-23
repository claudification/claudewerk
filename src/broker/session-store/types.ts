import type { SessionSummary } from '../../shared/protocol'

export type { SessionSummary }

export interface DashboardMessage {
  type:
    | 'session_update'
    | 'session_created'
    | 'session_ended'
    | 'event'
    | 'sessions_list'
    | 'sentinel_status'
    | 'toast'
    | 'settings_updated'
    | 'project_settings_updated'
    | 'clipboard_capture'
    | 'usage_update'
  sessionId?: string
  previousSessionId?: string
  session?: SessionSummary
  sessions?: SessionSummary[]
  event?: unknown
  connected?: boolean
  machineId?: string
  hostname?: string
  title?: string
  message?: string
  settings?: unknown
}
