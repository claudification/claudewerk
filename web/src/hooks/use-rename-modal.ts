import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { renameModalBus } from '@/components/rename-modal-trigger'
import { useConversationsStore } from '@/hooks/use-conversations'
import { focusInputEditor } from '@/lib/focus-input'
import type { Conversation } from '@/lib/types'
import { haptic, isMobileViewport } from '@/lib/utils'

/** First value with non-whitespace content, else ''. */
function firstNonEmpty(...vals: (string | undefined)[]) {
  for (const v of vals) if (v?.trim()) return v
  return ''
}

/** The recap-suggested name for a conversation, trimmed, or '' if none. */
function suggestedName(conversation: Conversation | undefined) {
  const name = conversation?.recap?.name
  return name ? name.trim() : ''
}

/** Label shown next to the modal title: current name, agent name, or a short id. */
function headerLabelFor(conversation: Conversation | undefined, conversationId: string | null) {
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
function focusAndSelect(ref: { current: HTMLInputElement | null }) {
  requestAnimationFrame(() => {
    ref.current?.focus()
    ref.current?.select()
  })
}

/** Live state the open handler reads without stale closures. */
interface LiveState {
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
 *  `submit` -- this is what makes a second Ctrl+Shift+R a one-chord accept.
 *  Otherwise it seeds the fields and opens. */
function useOpenSync(
  live: { current: LiveState },
  submit: (name: string, desc: string) => void,
  setFields: (name: string, desc: string) => void,
  setOpen: (v: boolean) => void,
) {
  useEffect(() => {
    function handleOpen(detail?: { name?: string }) {
      const cur = live.current
      if (!cur.selectedConversationId) return
      if (cur.open) {
        submit(acceptName(cur), cur.description)
        return
      }
      seedAndOpen(cur.selectedConversationId, detail?.name, setFields, setOpen)
    }
    renameModalBus.setHandler(handleOpen)
    return () => renameModalBus.setHandler(null)
  }, [live, submit, setFields, setOpen])
}

export type RenameModalState = ReturnType<typeof useRenameModal>

/** State + behavior for the rename modal, lifted out of the component so the
 *  .tsx stays presentational. Owns the open/seed lifecycle, the recap-name
 *  suggestion, and the "press the rename chord again to accept" gesture. */
export function useRenameModal() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const conversation = useConversationsStore(s =>
    s.selectedConversationId ? s.conversationsById[s.selectedConversationId] : undefined,
  )
  const renameConversation = useConversationsStore(s => s.renameConversation)

  const suggestion = suggestedName(conversation)
  const showSuggestion = suggestion.length > 0 && suggestion !== name.trim()
  const headerLabel = headerLabelFor(conversation, selectedConversationId)

  // Live snapshot so the once-registered open handler reads current state.
  const live = useRef<LiveState>({ open, name, description, suggestion, selectedConversationId })
  live.current = { open, name, description, suggestion, selectedConversationId }

  const submitWith = useCallback(
    (rawName: string, rawDesc: string) => {
      const sid = live.current.selectedConversationId
      const trimmed = rawName.trim()
      if (!sid || !trimmed) return
      renameConversation(sid, trimmed, rawDesc.trim() || undefined)
      haptic('success')
      setOpen(false)
    },
    [renameConversation],
  )

  const setFields = useCallback((nm: string, desc: string) => {
    setName(nm)
    setDescription(desc)
  }, [])

  useOpenSync(live, submitWith, setFields, setOpen)

  useEffect(() => {
    if (open) focusAndSelect(nameRef)
  }, [open])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) return
      setFields('', '')
      if (!isMobileViewport()) requestAnimationFrame(() => focusInputEditor())
    },
    [setFields],
  )

  const handleSubmit = useCallback(() => {
    submitWith(live.current.name, live.current.description)
  }, [submitWith])

  const applySuggestion = useCallback((value: string) => {
    setName(value)
    focusAndSelect(nameRef)
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey) return
      e.preventDefault()
      handleSubmit()
    },
    [handleSubmit],
  )

  return {
    open,
    name,
    description,
    selectedConversationId,
    headerLabel,
    suggestion,
    showSuggestion,
    nameRef,
    setName,
    setDescription,
    handleOpenChange,
    handleSubmit,
    applySuggestion,
    handleKeyDown,
  }
}
