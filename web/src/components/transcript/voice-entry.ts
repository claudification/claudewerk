import type { InputSource } from '@shared/protocol'
import { stripInputSourceHint, VOICE_HINT_ATTR } from '@shared/voice-hint'
import type { TranscriptContentBlock } from '@/lib/types'
import type { RenderItem } from './group-view-types'

/**
 * Lift the agent host's dictation hint off a user entry before anything renders
 * it. The prompt Claude Code recorded in its JSONL is the one that was SENT --
 * hint included -- so this is the only place that difference can be undone.
 *
 * Content arrives as a bare string or as blocks; the hint is always PREPENDED,
 * so in the block form only the first text block can be carrying it.
 */
export function liftInputSourceHint(content: string | TranscriptContentBlock[] | undefined): {
  content: string | TranscriptContentBlock[] | undefined
  source?: InputSource
} {
  if (typeof content === 'string') {
    const { text, source } = stripInputSourceHint(content)
    return { content: text, source }
  }
  if (!Array.isArray(content)) return { content }
  const i = content.findIndex(b => b.type === 'text' && typeof b.text === 'string' && b.text.includes(VOICE_HINT_ATTR))
  if (i === -1) return { content }
  const { text, source } = stripInputSourceHint(content[i].text as string)
  if (!source) return { content }
  const next = content.slice()
  next[i] = { ...content[i], text }
  return { content: next, source }
}

/**
 * Flag the items ONE entry just produced as dictated. Provenance belongs to the
 * entry, so the caller records where its items started and marks only those --
 * marking by predicate would bleed onto a typed entry parsed into the same array.
 */
export function markDictated(items: RenderItem[], from: number): void {
  for (let i = from; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'text') item.voice = true
  }
}
