/**
 * Fetch ONE conversation the roster does not carry.
 *
 * Since 1143f57b the `conversations_list` boot payload ships only NON-ended
 * conversations (2312 of 2367 rows were ended). Anything that can name a
 * conversation from outside that roster -- transcript search, the command
 * palette, a notification deep-link, a commit-ledger link, a bookmarked
 * `#conversation/<id>` hash, the project summary page's Recent list -- can hand
 * the store an id it has never seen. This is the read that fills that gap.
 *
 * Deliberately store-free (no import of use-conversations) so the store can
 * import it without a cycle. The caller owns the upsert.
 */

import type { ConversationSummary } from '@shared/protocol'
import { toConversation } from '@/lib/to-conversation'
import type { Conversation } from '@/lib/types'

/** Never throws: a 404 (genuinely gone), an abort (navigated away again) and a
 *  network failure are all ordinary outcomes on a navigation path. */
export async function fetchConversationById(id: string, signal?: AbortSignal): Promise<Conversation | null> {
  try {
    const res = await fetch(`/conversations/${encodeURIComponent(id)}`, { signal })
    if (!res.ok) {
      console.warn(`[nav] hydrate ${id.slice(0, 8)} -> HTTP ${res.status}`)
      return null
    }
    return toConversation((await res.json()) as ConversationSummary)
  } catch (err) {
    if (signal?.aborted) return null
    console.warn(`[nav] hydrate ${id.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
