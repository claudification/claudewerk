import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'

/** Give up waiting for the recap after this long (it's a single fast Haiku call,
 *  so this is just a safety valve against a dropped/failed generation). */
const AUTO_NAME_TIMEOUT_MS = 30_000

/** Fire a background away-summary recap for a conversation and auto-apply the
 *  suggested name to its title the moment it lands -- no UI, no waiting. The
 *  watcher is a store subscription (not a component effect), so it survives the
 *  rename modal closing and any conversation switch. Scoped to one conversation;
 *  self-unsubscribes on success or after a timeout. */
export function requestRecapAutoName(conversationId: string): void {
  const store = useConversationsStore
  let settled = false
  let unsubscribe: () => void = () => {}
  let timer: ReturnType<typeof setTimeout>

  const finish = () => {
    if (settled) return
    settled = true
    unsubscribe()
    clearTimeout(timer)
  }

  unsubscribe = store.subscribe(state => {
    const conv = state.conversationsById[conversationId]
    const name = conv?.recap?.name?.trim()
    if (!name) return
    finish()
    // Skip the rename if the title already matches -- the broker may have
    // applied the suggestion itself, or the user renamed it meanwhile.
    if (name !== conv?.title) state.renameConversation(conversationId, name)
  })

  timer = setTimeout(finish, AUTO_NAME_TIMEOUT_MS)

  haptic('tap')
  wsSend('recap_request', { conversationId })
}
