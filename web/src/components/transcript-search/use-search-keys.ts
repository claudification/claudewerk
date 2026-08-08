import { useCallback } from 'react'

interface KeyContext {
  itemCount: number
  setActiveIndex: (fn: (i: number) => number) => void
  /** Conversation for the row at the active index, hot or cold. */
  activeConversationId: string | null
  /** Conversation to drill into -- only set when a hot conversation row is active. */
  drillTarget: string | null
  inSnippetMode: boolean
  queryIsEmpty: boolean
  goTo: (conversationId: string) => void
  drillInto: (conversationId: string) => void
  drillOut: () => void
  close: () => void
}

export interface SearchKeysInput {
  /** Hot rows first, cold rows after -- one index walks both. */
  hotHits: Array<{ conversationId: string }>
  coldHits: Array<{ conversationId: string }>
  /** Only conversation rows can be drilled into; snippet and cold rows cannot. */
  drillableHits: Array<{ conversationId: string }>
  activeIndex: number
  setActiveIndex: (fn: (i: number) => number) => void
  inSnippetMode: boolean
  query: string
  goTo: (conversationId: string) => void
  drillInto: (conversationId: string) => void
  drillOut: () => void
  close: () => void
}

/** One handler per key, not a switch: the list is long enough that a chain
 *  hides which keys are actually bound. */
const KEY_HANDLERS: Record<string, (ctx: KeyContext) => void> = {
  ArrowDown: ctx => ctx.setActiveIndex(i => Math.min(i + 1, ctx.itemCount - 1)),
  ArrowUp: ctx => ctx.setActiveIndex(i => Math.max(i - 1, 0)),
  Enter: ctx => {
    if (ctx.activeConversationId) ctx.goTo(ctx.activeConversationId)
  },
  Escape: ctx => (ctx.inSnippetMode ? ctx.drillOut() : ctx.close()),
  Tab: ctx => {
    if (ctx.drillTarget) ctx.drillInto(ctx.drillTarget)
  },
  Backspace: ctx => {
    // Only when there is nothing left to delete -- otherwise this is ordinary
    // text editing and must not navigate.
    if (ctx.queryIsEmpty && ctx.inSnippetMode) ctx.drillOut()
  },
}

/** Backspace stays a normal edit key until the field is empty, so it is the one
 *  binding that must not preventDefault. */
const PASSTHROUGH_KEYS = new Set(['Backspace'])

/** Resolves which row the keys act on, so the caller never does index math. */
function toKeyContext(input: SearchKeysInput): KeyContext {
  const { hotHits, coldHits, drillableHits, activeIndex } = input
  const activeHit = coldHits[activeIndex - hotHits.length] ?? hotHits[activeIndex]
  return {
    itemCount: hotHits.length + coldHits.length,
    setActiveIndex: input.setActiveIndex,
    activeConversationId: activeHit?.conversationId ?? null,
    drillTarget: drillableHits[activeIndex]?.conversationId ?? null,
    inSnippetMode: input.inSnippetMode,
    queryIsEmpty: input.query === '',
    goTo: input.goTo,
    drillInto: input.drillInto,
    drillOut: input.drillOut,
    close: input.close,
  }
}

export function useSearchKeys(input: SearchKeysInput) {
  const ctx = toKeyContext(input)
  return useCallback(
    (e: React.KeyboardEvent) => {
      const handler = KEY_HANDLERS[e.key]
      if (!handler) return
      if (!PASSTHROUGH_KEYS.has(e.key)) e.preventDefault()
      handler(ctx)
    },
    [ctx],
  )
}
