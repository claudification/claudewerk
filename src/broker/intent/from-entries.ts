/**
 * Adapter: normalized `TranscriptEntry[]` -> classifier context.
 *
 * Two callers read transcripts from two different places. The agent-host side
 * gets RAW CC JSONL out of the store and parses it (`buildIntentContext`); the
 * broker's recap side already holds normalized `TranscriptEntry` objects. This
 * is the second door into the same room, so both feed the one classifier
 * instead of growing a second prompt each.
 *
 * Reuses `extractUserText` / `extractAssistantText` rather than re-deriving the
 * block-walking, so a CC content-shape change is fixed in one place.
 */

import type { TranscriptAssistantEntry, TranscriptEntry, TranscriptUserEntry } from '../../shared/protocol'
import { type IntentContext, isInjected } from '../../shared/transcript-intent-context'
import { extractAssistantText, extractUserText } from '../recap/shared/transcript-extract'

/** `Bash`'s mandatory `description` is a free, human-written label for the
 *  action -- the cheapest signal we have for "what is it doing". */
function toolLabel(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null
  const b = block as { type?: string; name?: string; input?: Record<string, unknown> }
  if (b.type !== 'tool_use') return null
  const desc = typeof b.input?.description === 'string' ? b.input.description : undefined
  return desc ? `[${b.name}] ${desc}` : `[${b.name}]`
}

function toolLabels(entry: TranscriptAssistantEntry): string[] {
  const content = entry.message?.content
  return Array.isArray(content) ? content.map(toolLabel).filter((l): l is string => !!l) : []
}

/** One assistant turn as an activity line: its prose plus its tool labels. */
function assistantActivity(entry: TranscriptAssistantEntry): string | null {
  const prose = extractAssistantText(entry)?.trim().slice(0, 200)
  const bits = [prose || '', ...toolLabels(entry)].filter(Boolean)
  return bits.length ? bits.join(' | ') : null
}

/** One human turn, or null when it is the harness talking. Injected turns (hook
 *  output, system reminders, image placeholders) are not the human, and naming a
 *  session after our own tooling is exactly the bug the benchmark surfaced. */
function humanTurn(entry: TranscriptEntry): IntentContext['userMessages'][number] | null {
  const text = extractUserText(entry as TranscriptUserEntry)?.trim()
  if (!text || isInjected(text)) return null
  return { text: text.slice(0, 2000), atMs: entryMs(entry) }
}

/** Recap text from an earlier away_summary pass over this same conversation. */
function priorRecap(entry: TranscriptEntry): string | null {
  const sys = entry as { subtype?: string; content?: unknown }
  if (sys.subtype !== 'away_summary' || typeof sys.content !== 'string') return null
  try {
    const parsed = JSON.parse(sys.content) as { recap?: unknown }
    return typeof parsed.recap === 'string' && parsed.recap.trim() ? parsed.recap.trim() : null
  } catch {
    return null
  }
}

function entryMs(entry: TranscriptEntry): number {
  const ts = (entry as { timestamp?: unknown }).timestamp
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') return Date.parse(ts) || 0
  return 0
}

export function intentContextFromEntries(entries: TranscriptEntry[], maxActivity = 25): IntentContext {
  const userMessages: IntentContext['userMessages'] = []
  const activity: string[] = []
  const background: string[] = []

  for (const entry of entries) {
    if (entry.type === 'user') {
      const turn = humanTurn(entry)
      if (turn) userMessages.push(turn)
    } else if (entry.type === 'assistant') {
      const act = assistantActivity(entry as TranscriptAssistantEntry)
      if (act) activity.push(act)
    } else if (entry.type === 'system') {
      const prior = priorRecap(entry)
      if (prior) background.push(prior)
    }
  }

  return {
    userMessages,
    activity: activity.slice(-maxActivity),
    ...(background.length && { background: background.slice(-3).join(' ') }),
  }
}
