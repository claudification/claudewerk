/**
 * THE DIALOGUE -- app-shell-level mount for all live dialog modals.
 *
 * One LiveDialogModal per conversation that has an active live dialog. Mounted
 * once in app.tsx so each dialog stays alive across conversation switches (the
 * managed modal system handles portaling + dock tiles + detached windows).
 */

import { useMemo } from 'react'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { LiveDialogModal } from './live-dialog-modal'

export function LiveDialogModals() {
  const byConversation = useLiveDialogsStore(s => s.byConversation)
  const ids = useMemo(() => Object.keys(byConversation), [byConversation])
  if (ids.length === 0) return null
  return ids.map(id => <LiveDialogModal key={id} conversationId={id} />)
}
