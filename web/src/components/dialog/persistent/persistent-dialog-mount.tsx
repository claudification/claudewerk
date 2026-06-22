/**
 * THE DIALOGUE (D2) — eager gate for the persistent dialog. Subscribes to the
 * live-dialog store (cheap) and lazy-loads the renderer ONLY when an EXPANDED
 * live dialog exists for this conversation (LAZY LOAD covenant: the heavy
 * ComponentRenderer + plan blocks + markdown travel in the on-demand chunk).
 *
 * When the dialog is collapsed (user minimized it, or the agent closed it) we
 * render the tiny inline bar instead -- no heavy chunk. An agent-closed dialog
 * also gets a hard-removal timer here: once its decay window elapses it is
 * dropped from this client's view (the broker keeps it for reopen).
 */
import { lazy, Suspense, useEffect } from 'react'
import { CLOSED_DECAY_MS, useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { CollapsedDialogBar } from './collapsed-dialog-bar'

const PersistentDialog = lazy(() => import('./persistent-dialog').then(m => ({ default: m.PersistentDialog })))

export function PersistentDialogMount({ conversationId }: { conversationId: string }) {
  const entry = useLiveDialogsStore(s => s.byConversation[conversationId])
  const collapsed = useLiveDialogsStore(s => s.viewByConversation[conversationId]?.collapsed ?? false)
  const closedAt = useLiveDialogsStore(s => s.viewByConversation[conversationId]?.closedAt)
  const setCollapsed = useLiveDialogsStore(s => s.setCollapsed)
  const dismiss = useLiveDialogsStore(s => s.dismiss)

  // Hard-hide an agent-closed dialog once its decay window elapses. Re-derived
  // from closedAt so it survives a remount (timers don't, the timestamp does).
  useEffect(() => {
    if (closedAt === undefined) return
    const remaining = closedAt + CLOSED_DECAY_MS - Date.now()
    if (remaining <= 0) {
      dismiss(conversationId)
      return
    }
    const t = setTimeout(() => dismiss(conversationId), remaining)
    return () => clearTimeout(t)
  }, [closedAt, conversationId, dismiss])

  if (!entry) return null
  if (collapsed) {
    return (
      <CollapsedDialogBar
        title={entry.snapshot.layout.title}
        closedAt={closedAt}
        onExpand={() => setCollapsed(conversationId, false)}
        onDismiss={() => dismiss(conversationId)}
      />
    )
  }
  return (
    <Suspense fallback={null}>
      <PersistentDialog key={entry.dialogId} conversationId={conversationId} entry={entry} />
    </Suspense>
  )
}
