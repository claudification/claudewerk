import { useCallback, useEffect, useState } from 'react'
import { renameModalBus } from '@/components/rename-modal-trigger'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
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

/** What the chord accepts while open: the suggestion if present, else the field. */
function acceptName(cur: LiveState) {
  return cur.suggestion || cur.name
}

/** The chord pressed while already open: save what's there if anything, else
 *  fetch a name via a background recap. */
function acceptOrFetch(cur: LiveState, submit: (name: string, desc: string) => void, requestName: () => void) {
  const accept = acceptName(cur).trim()
  if (accept) submit(accept, cur.description)
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

/** The "suggest a name" concern: fire a background away-summary recap, then drop
 *  the resulting `conversation.recap.name` into the (still-empty) field when it
 *  arrives. Times out the spinner if the recap never lands. Lifted out so the
 *  main hook stays small. */
export function useRecapNameRequest(args: {
  live: { current: LiveState }
  suggestion: string
  name: string
  setName: (v: string) => void
  nameRef: { current: HTMLInputElement | null }
}) {
  const { live, suggestion, name, setName, nameRef } = args
  const [requestingName, setRequestingName] = useState(false)

  const requestRecapName = useCallback(() => {
    const sid = live.current.selectedConversationId
    if (!sid) return
    haptic('tap')
    setRequestingName(true)
    wsSend('recap_request', { conversationId: sid })
  }, [live])

  // Land the suggestion when it arrives -- never clobber what the user typed
  // while waiting.
  useEffect(() => {
    if (!requestingName || !suggestion || name.trim()) return
    setName(suggestion)
    focusAndSelect(nameRef)
    haptic('success')
    setRequestingName(false)
  }, [requestingName, suggestion, name, setName, nameRef])

  // Drop the spinner if the recap fails / never comes back.
  useEffect(() => {
    if (!requestingName) return
    const t = setTimeout(() => setRequestingName(false), 20_000)
    return () => clearTimeout(t)
  }, [requestingName])

  const clearRequestingName = useCallback(() => setRequestingName(false), [])
  return { requestingName, requestRecapName, clearRequestingName }
}
