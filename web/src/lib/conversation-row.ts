import { formatCost, getConversationCost, getCostBgColor } from './cost-utils'
import type { Conversation } from './types'
import { contextWindowSize } from './utils'

/** Display title for a list row: title -> agentName -> short id, capped. */
export function rowTitle(conversation: Conversation, maxLen = 28): string {
  return (conversation.title || conversation.agentName || '').slice(0, maxLen) || conversation.id.slice(0, 8)
}

/** Subtitle line for a list row: description -> summary -> recap title. */
export function rowSubtitle(conversation: Conversation): string | undefined {
  return conversation.description || conversation.summary || conversation.recap?.title
}

/** Human-readable title for a conversation's last API error (badge tooltip). */
export function errorTitle(conversation: Conversation): string {
  return conversation.lastError?.errorMessage || conversation.lastError?.errorType || 'API error'
}

export interface ContextPct {
  pct: number
  /** tailwind text color class for the % label */
  color: string
  /** tailwind bg color class for the progress bar fill */
  barColor: string
}

/**
 * Derive the context-window fill % + threshold-tinted colors for a conversation.
 * Pure -- callers gate on the `showContextInList` pref before calling.
 * Shared by the default (compact) row and the status-rail row so both read
 * one source of truth (see feedback_no_duplication).
 */
export function deriveContextPct(conversation: Conversation): ContextPct | null {
  if (!conversation.tokenUsage) return null
  const { input, cacheCreation, cacheRead } = conversation.tokenUsage
  const total = input + cacheCreation + cacheRead
  if (total === 0) return null
  const maxTokens = conversation.contextWindow ?? contextWindowSize(conversation.model)
  const pct = Math.min(100, Math.round((total / maxTokens) * 100))
  const threshold = conversation.autocompactPct || 83
  const warnAt = threshold - 5
  const color = pct < warnAt ? 'text-emerald-400/60' : pct < threshold ? 'text-amber-400/60' : 'text-red-400/70'
  const barColor = pct < warnAt ? 'bg-emerald-400/60' : pct < threshold ? 'bg-amber-400/60' : 'bg-red-400/70'
  return { pct, color, barColor }
}

export interface CostInfo {
  cost: number
  exact: boolean
  /** tailwind text color class derived from cost magnitude */
  colorClass: string
}

/**
 * Derive the per-conversation cost chip (cost + a magnitude-tinted text color).
 * Returns null below $0.50 so trivial costs don't clutter the list. Pure --
 * callers gate on the `showCostInList` pref. Shared by compact + rail rows.
 */
export function deriveCostInfo(conversation: Conversation): CostInfo | null {
  if (!conversation.stats) return null
  const { cost, exact } = getConversationCost(conversation.stats, conversation.model)
  if (cost < 0.5) return null
  return { cost, exact, colorClass: getCostBgColor(cost).split(' ')[1] }
}

/** Format a derived CostInfo for display (e.g. "$1.18"). */
export function formatCostInfo(info: CostInfo): string {
  return formatCost(info.cost, info.exact)
}
