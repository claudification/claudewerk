/**
 * THE DIALOGUE (D2) — the submit machinery for a persistent dialog, split out of
 * the component so the render file stays under the LOC cap.
 *
 * Owns the in-flight "sent, waiting for the agent" state (the wait bar), the
 * soft-deadline nudge, and the chosen secondary action. All of it is MIRRORED
 * into the live-dialog store every render so switching conversations (which
 * unmounts the dialog) and coming back does NOT lose the wait bar or the form.
 *
 * Two send paths:
 *   - onSubmit   -> a normal "send my comments" turn; the dialog stays open.
 *   - onFinalize -> the HARD terminal "this is final, we're done" signal: submits
 *                   with `_final: true` AND closes the dialog in the same gesture,
 *                   so it stops the moment the user commits (no lingering dialog).
 */
import { useEffect, useRef, useState } from 'react'
import type { LiveDialogEntry } from '@/hooks/use-live-dialogs'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { haptic } from '@/lib/utils'
import { materializeDrawValues } from '../draw-spill'

export interface DialogSubmit {
  pending: boolean
  overdue: boolean
  canSubmit: boolean
  activeAction: string | null
  setActiveAction: (id: string) => void
  /** `collapseAfter` (SHIFT+click): minimize on send + auto-restore on the reply. */
  onSubmit: (collapseAfter?: boolean) => void
  onFinalize: () => void
  cancel: () => void
}

/** `gateOpen` = the dialog is interactive and every required field has a value.
 *  The hook folds in the in-flight guard (`!pending`) to produce `canSubmit`. */
export function usePersistentDialogSubmit(
  entry: LiveDialogEntry,
  values: Record<string, unknown>,
  gateOpen: boolean,
): DialogSubmit {
  const conversationId = entry.conversationId
  const emit = useLiveDialogsStore(s => s.emit)
  const markSubmitted = useLiveDialogsStore(s => s.markSubmitted)
  const syncView = useLiveDialogsStore(s => s.syncView)
  const collapseForUpdate = useLiveDialogsStore(s => s.collapseForUpdate)
  const setCollapsed = useLiveDialogsStore(s => s.setCollapsed)

  const view = () => useLiveDialogsStore.getState().viewByConversation[conversationId]
  const [pending, setPending] = useState(() => view()?.pending ?? false)
  const [overdue, setOverdue] = useState(false)
  const [activeAction, setActiveActionState] = useState<string | null>(() => view()?.activeAction ?? null)
  const submitRev = useRef(view()?.submitRev ?? -1)

  // Mirror transient state down so a conversation switch can't wipe it.
  useEffect(() => {
    syncView(conversationId, { pending, submitRev: submitRev.current, activeAction })
  }, [conversationId, pending, activeAction, syncView])

  // A new apply (patch/reopen) after our submit clears the wait state.
  useEffect(() => {
    if (pending && entry.rev !== submitRev.current) {
      setPending(false)
      setOverdue(false)
    }
  }, [entry.rev, pending])
  // Broker rejected the event -> stop waiting; the error bar surfaces.
  useEffect(() => {
    if (entry.error) {
      setPending(false)
      setOverdue(false)
    }
  }, [entry.error])
  // Soft deadline -- a nudge, never a hard stop.
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => setOverdue(true), 12_000)
    return () => clearTimeout(t)
  }, [pending])

  const canSubmit = !pending && gateOpen

  const send = async (final: boolean, collapseAfter = false) => {
    if (!canSubmit) return
    haptic('success')
    // SHIFT+send: minimize instantly (out of the way) and arm auto-restore for
    // when the agent's patch lands. Never on finalize (that closes the dialog).
    const minimize = collapseAfter && !final
    if (minimize) collapseForUpdate(conversationId)
    // Lock the UI while any oversize drawing spills to a blob (async upload),
    // so a double-tap can't fire two turns mid-upload. Stamp submitRev FIRST so
    // the "new apply clears pending" effect doesn't misfire during the upload.
    submitRev.current = entry.rev
    setPending(true)
    const materialized = await materializeDrawValues(values, conversationId)
    const state: Record<string, unknown> = { ...materialized }
    if (activeAction) state._action = activeAction
    if (final) state._final = true
    if (!emit(conversationId, entry.dialogId, '__submit__', 'submit', undefined, state)) {
      setPending(false)
      // Send failed -> no agent reply is coming; restore so the error is visible.
      if (minimize) setCollapsed(conversationId, false)
      return
    }
    // Hard terminal: close in the same gesture so the dialog stops immediately.
    if (final) emit(conversationId, entry.dialogId, '__close__', 'close', undefined, {})
    markSubmitted(conversationId, entry.rev)
  }

  return {
    pending,
    overdue,
    canSubmit,
    activeAction,
    setActiveAction: setActiveActionState,
    onSubmit: (collapseAfter = false) => send(false, collapseAfter),
    onFinalize: () => send(true),
    cancel: () => setPending(false),
  }
}
