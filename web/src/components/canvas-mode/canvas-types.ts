// Shared shapes for THE CANVAS: flat, render-ready node data computed by
// layout.ts so the card components stay dumb (no store refs, no Maps).
import type { Conversation } from '@/lib/types'

export interface ConversationCardData {
  label: string
  status: Conversation['status']
  model?: string
  /** Pending dialog/permission/plan-approval -- the "needs you" badge. */
  attention?: string
  tokens: number
  costUsd?: number
  /** ms since lastActivity at layout time. */
  agoMs: number
  childCount: number
  compacting: boolean
  /** Expanded in place: the card grows and hosts a live mini-transcript. */
  expanded: boolean
  [k: string]: unknown // React Flow node data is an open record
}

/** One profile row on a sentinel node, pre-joined with its usage snapshot. */
export interface SentinelProfileRow {
  name: string
  pool?: string
  authed: boolean
  fiveHourPct?: number
  sevenDayPct?: number
  error?: string
}

export interface SentinelNodeData {
  sentinelId: string
  alias: string
  hostname?: string
  connected: boolean
  conversationCount: number
  profiles: SentinelProfileRow[]
  [k: string]: unknown
}

export interface ProjectSpaceData {
  label: string
  uri: string
  count: number
  activeCount: number
  /** Deterministic per-project hue (0-360) for the slight background tint. */
  hue: number
  [k: string]: unknown
}

export const STATUS_ACCENT: Record<Conversation['status'], { dot: string; label: string; pulse?: boolean }> = {
  active: { dot: 'var(--color-active)', label: 'active', pulse: true },
  idle: { dot: 'var(--color-idle)', label: 'idle' },
  starting: { dot: 'var(--color-info)', label: 'starting', pulse: true },
  booting: { dot: 'var(--color-info)', label: 'booting', pulse: true },
  ended: { dot: 'var(--color-ended)', label: 'ended' },
}

/** Deterministic hue from a project URI -- stable across reloads, no state. */
export function projectHue(uri: string): number {
  let h = 0
  for (let i = 0; i < uri.length; i++) h = (h * 31 + uri.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}

/** Display label for a conversation card: title beats agentName beats id stub. */
export function conversationLabel(c: Conversation): string {
  return c.title || c.agentName || c.id.slice(0, 13)
}
