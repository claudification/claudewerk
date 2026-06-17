/**
 * THE DIALOGUE (D2) — eager gate for the persistent dialog. Subscribes to the
 * live-dialog store (cheap) and lazy-loads the renderer ONLY when a live dialog
 * exists for this conversation (LAZY LOAD covenant: the heavy ComponentRenderer
 * + plan blocks + markdown travel in the on-demand chunk, never first paint).
 */
import { lazy, Suspense } from 'react'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'

const PersistentDialog = lazy(() => import('./persistent-dialog').then(m => ({ default: m.PersistentDialog })))

export function PersistentDialogMount({ conversationId }: { conversationId: string }) {
  const entry = useLiveDialogsStore(s => s.byConversation[conversationId])
  if (!entry) return null
  return (
    <Suspense fallback={null}>
      <PersistentDialog key={entry.dialogId} conversationId={conversationId} entry={entry} />
    </Suspense>
  )
}
