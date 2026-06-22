/**
 * THE DIALOGUE (D2) — local view of a persistent dialog's form: input VALUES,
 * the displayed LAYOUT (with a client-side undo override), the highlight set for
 * the last agent patch, and the undo ring.
 *
 * The split that kills flicker: the HOST owns structure (layout); the PANEL owns
 * input (values + focus + scroll). A patch never re-seeds an existing value --
 * only an explicit setState op changes one (red/blue-team R1#4). New blocks get
 * their defaults; everything the user typed survives.
 *
 * Values SEED from the live-dialog store (so they survive a conversation switch
 * that unmounts this dialog); the parent mirrors them back down on change. Undo
 * ring + highlight stay component-local -- they're cosmetic and fine to reset.
 */
import type { DialogOp } from '@shared/dialog-live'
import type { DialogLayout } from '@shared/dialog-schema'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LiveDialogEntry } from '@/hooks/use-live-dialogs'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { getInitialValues, reconcileValues } from '../dialog-form-init'
import type { DialogFormState } from '../dialog-renderer'

const UNDO_RING_MAX = 10
const HIGHLIGHT_MS = 1400

/** Block ids the agent structurally touched in this patch (for the highlight). */
function changedIds(ops: DialogOp[]): Set<string> {
  const ids = new Set<string>()
  for (const op of ops) {
    if (op.op === 'replace' || op.op === 'remove') ids.add(op.id)
    else if (op.op === 'append') {
      if (op.into) ids.add(op.into)
      const blockId = (op.block as { id?: string }).id
      if (blockId) ids.add(blockId)
    }
  }
  return ids
}

export interface PersistentForm {
  form: DialogFormState
  values: Record<string, unknown>
  layout: DialogLayout
  highlightIds: Set<string>
  canUndo: boolean
  undo: () => void
}

export function usePersistentDialogForm(entry: LiveDialogEntry): PersistentForm {
  // Seed from the store so a half-filled form survives the unmount a conversation
  // switch causes; fall back to layout defaults for a fresh dialog.
  const [values, setValues] = useState<Record<string, unknown>>(
    () =>
      useLiveDialogsStore.getState().viewByConversation[entry.conversationId]?.values ??
      getInitialValues(entry.snapshot.layout),
  )
  const [highlightIds, setHighlightIds] = useState<Set<string>>(() => new Set())
  const [override, setOverride] = useState<DialogLayout | null>(null)
  const appliedRev = useRef(entry.rev)
  const displayed = useRef<DialogLayout>(entry.snapshot.layout)
  const ring = useRef<DialogLayout[]>([])
  const [canUndo, setCanUndo] = useState(false)

  // Reconcile on every apply (rev bumps even when seq is unchanged, e.g. replay).
  useEffect(() => {
    if (entry.rev === appliedRev.current) return
    appliedRev.current = entry.rev
    if (!entry.replay && entry.lastOps.length > 0) {
      // Real agent patch: ring the layout shown until now (undo target), flash.
      ring.current = [...ring.current, displayed.current].slice(-UNDO_RING_MAX)
      setCanUndo(true)
      setHighlightIds(changedIds(entry.lastOps))
    }
    displayed.current = entry.snapshot.layout
    setOverride(null) // a fresh host snapshot supersedes any local undo view
    setValues(prev => reconcileValues(prev, entry.snapshot.layout, entry.lastOps))
  }, [entry])

  // Clear the highlight after the flash.
  useEffect(() => {
    if (highlightIds.size === 0) return
    const t = setTimeout(() => setHighlightIds(new Set()), HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [highlightIds])

  // Mirror input values into the store so a half-filled form survives the
  // unmount a conversation switch causes (rehydrated by the seed above).
  const syncView = useLiveDialogsStore(s => s.syncView)
  useEffect(() => {
    syncView(entry.conversationId, { values })
  }, [values, entry.conversationId, syncView])

  const form = useMemo<DialogFormState>(
    () => ({
      values,
      setValue: (id, v) => setValues(prev => ({ ...prev, [id]: v })),
      conversationId: entry.conversationId,
    }),
    [values, entry.conversationId],
  )

  return {
    form,
    values,
    layout: override ?? entry.snapshot.layout,
    highlightIds,
    canUndo,
    undo: () => {
      const prev = ring.current.pop()
      if (!prev) return
      displayed.current = prev
      setOverride(prev)
      setCanUndo(ring.current.length > 0)
    },
  }
}
