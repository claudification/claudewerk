import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import {
  focusAndSelect,
  headerLabelFor,
  type LiveState,
  suggestedName,
  useOpenSync,
} from '@/hooks/use-rename-modal-internals'
import { focusInputEditor } from '@/lib/focus-input'
import { requestRecapAutoName } from '@/lib/recap-auto-name'
import { haptic, isMobileViewport } from '@/lib/utils'

export type RenameModalState = ReturnType<typeof useRenameModal>

/** State + behavior for the rename modal, lifted out of the component so the
 *  .tsx stays presentational. Owns the open/seed lifecycle, the recap-name
 *  suggestion, and the "press the rename chord again to accept" gesture. The
 *  open/seed + recap-fetch plumbing lives in use-rename-modal-internals. */
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

  const resetAndClose = useCallback(() => {
    setOpen(false)
    setFields('', '')
    if (!isMobileViewport()) requestAnimationFrame(() => focusInputEditor())
  }, [setFields])

  // The async chord: minimize the modal immediately, then fire a background
  // recap that auto-applies the generated name when it lands. No spinner, no
  // waiting -- the title just updates itself.
  const requestRecapName = useCallback(() => {
    const sid = live.current.selectedConversationId
    if (!sid) return
    requestRecapAutoName(sid)
    resetAndClose()
  }, [resetAndClose])

  useOpenSync(live, submitWith, requestRecapName, setFields, setOpen)

  useEffect(() => {
    if (open) focusAndSelect(nameRef)
  }, [open])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setOpen(true)
        return
      }
      resetAndClose()
    },
    [resetAndClose],
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
