import { useEffect } from 'react'
import { renameModalBus } from '@/components/rename-modal-trigger'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { haptic } from '@/lib/utils'

/** First value with non-whitespace content, else ''. */
function firstNonEmpty(...vals: (string | undefined)[]) {
  for (const v of vals) if (v?.trim()) return v
  return ''
}

/** The recap-suggested name for a conversation, trimmed, or '' if none. */
export function suggestedName(conversation: Conversation | undefined) {
  const name = conversation?.recap?.name
  return name ? name.trim() : ''
}

/** Label shown next to the modal title: current name, agent name, or a short id. */
export function headerLabelFor(conversation: Conversation | undefined, conversationId: string | null) {
  if (conversation) {
    const label = firstNonEmpty(conversation.title, conversation.agentName)
    if (label) return label
  }
  return conversationId ? conversationId.slice(0, 12) : ''
}

/** Initial field values when opening fresh: an explicit caller name wins, else
 *  the current title, else the recap-suggested name. */
function seedFields(sess: Conversation | undefined, override: string | undefined) {
  if (!sess) return { name: firstNonEmpty(override), description: '' }
  return {
    name: firstNonEmpty(override, sess.title, sess.recap?.name),
    description: sess.description ?? '',
  }
}

/** rAF-deferred focus + select of the name input (runs after the dialog paints).
 *  Shared by open and apply-suggestion. */
export function focusAndSelect(ref: { current: HTMLInputElement | null }) {
  requestAnimationFrame(() => {
    ref.current?.focus()
    ref.current?.select()
  })
}

/** Live state the open handler reads without stale closures. */
export interface LiveState {
  open: boolean
  name: string
  description: string
  suggestion: string
  selectedConversationId: string | null
}

/** The chord pressed while already open: accept the recap suggestion if there is
 *  one, else fire a background recap that auto-applies a name (`requestName`,
 *  which also closes the modal). Gated on the SUGGESTION, not the field -- the
 *  field is pre-seeded with the current title, so it's almost never empty and
 *  can't be the trigger. Enter remains the save-the-field gesture. */
function acceptOrFetch(cur: LiveState, submit: (name: string, desc: string) => void, requestName: () => void) {
  if (cur.suggestion.trim()) submit(cur.suggestion, cur.description)
  else requestName()
}

/** Seed the fields from the conversation and open the modal. */
function seedAndOpen(
  conversationId: string,
  override: string | undefined,
  setFields: (name: string, desc: string) => void,
  setOpen: (v: boolean) => void,
) {
  const sess = useConversationsStore.getState().conversationsById[conversationId]
  const seed = seedFields(sess, override)
  setFields(seed.name, seed.description)
  haptic('tap')
  setOpen(true)
}

/** Bridges the `open-rename-modal` bus event into local state. When fired while
 *  already open it acts as "accept": saves the suggestion (or current value) via
 *  `submit` -- this is what makes a second Ctrl+Shift+R a one-chord accept. When
 *  there's nothing to accept (no recap name, empty field), it instead fires a
 *  background recap to fetch a name (`requestName`). Otherwise it seeds + opens. */
export function useOpenSync(
  live: { current: LiveState },
  submit: (name: string, desc: string) => void,
  requestName: () => void,
  setFields: (name: string, desc: string) => void,
  setOpen: (v: boolean) => void,
) {
  useEffect(() => {
    function handleOpen(detail?: { name?: string }) {
      const cur = live.current
      if (!cur.selectedConversationId) return
      if (cur.open) return acceptOrFetch(cur, submit, requestName)
      seedAndOpen(cur.selectedConversationId, detail?.name, setFields, setOpen)
    }
    renameModalBus.setHandler(handleOpen)
    return () => renameModalBus.setHandler(null)
  }, [live, submit, requestName, setFields, setOpen])
}
