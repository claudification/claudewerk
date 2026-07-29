/**
 * `/rename` typed inside Claude Code, turned into an authoritative rename.
 *
 * Lives here rather than in one host because THREE transports need it and each
 * sees a different shape of the same event. Measured against CC 2.1.220:
 *
 *   PTY      -- a `system` / `local_command` entry whose content is
 *               `<local-command-stdout>Session renamed to: X</local-command-stdout>`.
 *   headless -- a SYNTHETIC assistant message (`model: "<synthetic>"`) whose only
 *               text is `Session renamed to: X`, delivered over stdout. The
 *               local_command twin IS written to the JSONL, but headless forwards
 *               that subtype only inside a REPLAY batch (transcript-entry-filter.ts),
 *               so matching it alone left `/rename` invisible on the entire
 *               headless fleet -- 22 local_command rows in the production store,
 *               newest 2026-06-07, all PTY-era.
 *   daemon   -- reads the JSONL directly, so it sees the local_command shape.
 *
 * Both shapes carry a uuid AND a real timestamp, which is the property the whole
 * design rests on: the broker ranks a rename by ITS OWN clock, so a replayed one
 * is visibly older than the title it would overwrite and loses without anyone
 * having to decide whether a batch is a replay.
 */

import type { RenameConversationRequest, TranscriptEntry } from '../shared/protocol'

const RENAMED_RE = /Session renamed to: ([^<\n]+)/

/** The synthetic model id CC stamps on a locally-generated (non-API) reply.
 *  REQUIRED for the assistant shape: without it, an assistant merely WRITING
 *  the sentence would rename the conversation. */
const SYNTHETIC_MODEL = '<synthetic>'

function titleFromLocalCommand(e: Record<string, unknown>): string | undefined {
  if (e.type !== 'system' || e.subtype !== 'local_command' || typeof e.content !== 'string') return undefined
  return e.content.match(RENAMED_RE)?.[1].trim()
}

function titleFromSyntheticAssistant(e: Record<string, unknown>): string | undefined {
  if (e.type !== 'assistant') return undefined
  const message = e.message as { model?: string; content?: unknown } | undefined
  if (message?.model !== SYNTHETIC_MODEL || !Array.isArray(message.content)) return undefined
  const text = message.content
    .filter((c: unknown) => (c as Record<string, unknown>)?.type === 'text')
    .map((c: unknown) => String((c as Record<string, string>).text ?? ''))
    .join('')
    .trim()
  return text.match(RENAMED_RE)?.[1].trim()
}

/** The name a `/rename` settled on, or undefined when this entry is not one. */
export function renamedTitleOf(entry: TranscriptEntry): string | undefined {
  const e = entry as Record<string, unknown>
  return titleFromLocalCommand(e) ?? titleFromSyntheticAssistant(e)
}

/**
 * Every `/rename` in a batch, as ready-to-send wire messages.
 *
 * Deliberately NOT filtered by `isInitial`. A replayed rename is not dropped
 * here because it does not need to be -- it carries CC's own timestamp and the
 * broker's title-authority sees it is stale. Guessing "is this a replay" is what
 * the two previous attempts at this bug got wrong: `sendTranscriptEntriesChunked`
 * marks only the FIRST chunk, so the bit is not trustworthy per entry (1afa4954).
 * The timestamp is.
 */
export function renameRequestsIn(conversationId: string, entries: TranscriptEntry[]): RenameConversationRequest[] {
  const out: RenameConversationRequest[] = []
  for (const entry of entries) {
    const name = renamedTitleOf(entry)
    if (!name) continue
    const at = Date.parse(String(entry.timestamp ?? ''))
    out.push({
      type: 'rename_conversation',
      conversationId,
      name,
      origin: 'user',
      at: Number.isFinite(at) ? at : undefined,
    })
  }
  return out
}
