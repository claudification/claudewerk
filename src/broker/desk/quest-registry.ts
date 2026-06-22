/**
 * QUEST REGISTRY -- the connective tissue between a dispatched worker and the
 * user's dispatcher (plan §3 B3/B4).
 *
 * When the dispatcher spawns a worker to answer a question ("find this week's
 * sci-fi releases"), it parks a `<pending id=qN>` block in that user's living
 * history AND registers the link here, keyed by the worker's conversationId. When
 * the worker finishes it calls `send_message(to: "dispatcher", ...)`; the reserved
 * `dispatcher` sink (mcp-server) looks the worker up here to learn WHICH user's
 * dispatcher to wake and WHICH pending block the result resolves.
 *
 * In-memory by design: a working set, lost on restart (the worker can be re-asked).
 */

export interface QuestLink {
  /** The user whose dispatcher dispatched this worker (whose history to mutate). */
  userId: string | null
  /** The `<pending id=..>` block this worker's report resolves into `<findings>`. */
  pendingId: string
  /** Short human label of what was asked (for the synthetic impulse + UI). */
  intent: string
  /** Project label the quest belongs to, if any. */
  project?: string
}

const quests = new Map<string, QuestLink>()

/** Register a dispatched worker so its report-back can find the user's dispatcher. */
export function registerQuest(workerConversationId: string, link: QuestLink): void {
  quests.set(workerConversationId, link)
}

/** Resolve the quest a reporting worker belongs to (undefined = not a quest). */
export function resolveQuest(workerConversationId: string | null | undefined): QuestLink | undefined {
  return workerConversationId ? quests.get(workerConversationId) : undefined
}

/** Drop a quest once its report has been delivered (one-shot). */
export function clearQuest(workerConversationId: string): void {
  quests.delete(workerConversationId)
}

/** Test/forensics seam. */
export function questCount(): number {
  return quests.size
}
