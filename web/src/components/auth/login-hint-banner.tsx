/**
 * Reactive re-login hint. Shows a slim banner at the top of the selected
 * conversation when its headless inference is failing auth (a
 * `conversation_auth_needed` message landed). Clicking Authorize opens the
 * Login modal. Self-hides when there's no auth trouble for the selection.
 */

import { KeyRound } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { getAuthNeeded, getVersion, subscribe } from '@/hooks/auth-needed-store'
import { useConversationsStore } from '@/hooks/use-conversations'
import { openLogin } from '@/lib/open-login'

export function LoginHintBanner() {
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  useSyncExternalStore(subscribe, getVersion, getVersion)

  if (!selectedConversationId) return null
  const trouble = getAuthNeeded(selectedConversationId)
  if (!trouble) return null

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-amber-400/10 border-b border-amber-400/30 text-[11px]">
      <KeyRound className="size-3.5 text-amber-400 shrink-0" />
      <span className="text-amber-200/90 min-w-0 truncate">
        Authentication failed ({trouble.errorStatus}) -- this profile needs to re-login.
      </span>
      <button
        type="button"
        onClick={() => openLogin(selectedConversationId)}
        className="ml-auto shrink-0 px-2 py-0.5 rounded bg-amber-400 text-background font-bold hover:bg-amber-400/90"
      >
        Authorize
      </button>
    </div>
  )
}
