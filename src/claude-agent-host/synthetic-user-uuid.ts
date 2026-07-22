/**
 * The frozen identity of a dashboard-originated user prompt.
 *
 * A headless prompt travels two ways: LIVE over stdin (`sendUserMessage` echoes
 * it immediately) and LATER as a row in CC's JSONL transcript file (the watcher
 * re-reads it, minutes after, on any resend). CC stamps its OWN uuid on the file
 * row, so the two copies would land as two rows unless both carry the SAME id.
 *
 * Both paths stamp the id below -- a v5-shaped hash of the content -- so the
 * broker's `INSERT OR IGNORE (conversation_id, uuid)` collapses them into one
 * row at the LIVE copy's (correct) position, and the displaced file echo is
 * dropped instead of re-appended at the tail.
 *
 * The derivation is FROZEN: changing it re-splits the identity and resurrects
 * the duplicate. Keyed on the exact `content` string that was sent (including a
 * `<conduit>` wrapper when present) so the file echo -- which stores that same
 * string verbatim -- hashes identically.
 */

import { createHash } from 'node:crypto'
import type { TranscriptEntry } from '../shared/protocol'

/** The stash key tying a sent prompt to its later CC echo. */
export function userContentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16)
}

/** The uuid both copies of a dashboard user prompt are stamped with. */
export function syntheticUserUuid(conversationId: string, content: string): string {
  const h = createHash('sha1')
    .update(`user:${conversationId}:${userContentHash(content)}`)
    .digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Re-stamp headless dashboard prompts in a batch with their frozen
 * content-derived uuid, IN PLACE.
 *
 * In headless every user prompt originates from `sendUserMessage` (stdin), which
 * stamps the LIVE echo with `syntheticUserUuid`. CC's JSONL file gives the SAME
 * prompt its OWN uuid, so a file resend (isInitial) would re-insert it as a new
 * row at MAX(seq)+1 -- the first prompt then renders LAST. Re-deriving the same
 * id from the content makes the broker's INSERT OR IGNORE dedup the file echo
 * against the live row. Deterministic: a no-op on the live echo (already carries
 * this id), rewriting only the displaced file copy; it does not depend on the
 * send-time stash surviving (the file echo lands minutes later).
 *
 * String content only: tool-result user rows carry array content and meta rows
 * are not dashboard prompts -- both are left alone.
 */
export function unifyHeadlessPromptUuids(conversationId: string, entries: TranscriptEntry[]): void {
  for (const e of entries) {
    if (e.type !== 'user') continue
    const raw = e as Record<string, unknown>
    if (raw.isMeta === true || raw.isSynthetic === true) continue
    const content = (raw.message as { content?: unknown } | undefined)?.content
    if (typeof content !== 'string') continue
    e.uuid = syntheticUserUuid(conversationId, content)
  }
}
