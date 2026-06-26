/**
 * SOTU emit wiring for the headless agent host (Phase 3 COLLECT).
 *
 * Ties the streaming `CalloutScanner` + per-turn `TurnDigestCollector` to the
 * broker wire: it reads LIVE main-thread assistant text, forwards a `scribe_note`
 * for every inline `<callout>` (high weight), and at turn end forwards the
 * always-on `turn_digest` baseline floor. Both messages route through the broker's
 * single `recordContribution` chokepoint -- the host never writes a queue itself.
 *
 * BOUNDARY: this is the agent host (the only component allowed to read CC output).
 * It does NOT strip callouts from the transcript -- the prose is forwarded whole;
 * this is a non-destructive copy. The broker receives only structured messages.
 *
 * The `send` function is injected so this is unit-testable without a live socket.
 */

import type { ScribeNote, TranscriptEntry, TurnDigest } from '../shared/protocol'
import { CalloutScanner } from './sotu-callout-scanner'
import { TurnDigestCollector } from './sotu-turn-digest'

/** Sends a structured SOTU contribution to the broker. */
export type SotuSend = (msg: ScribeNote | TurnDigest) => void

/** A turn result shape (subset of CC's result message) the digest cares about. */
export interface SotuTurnResult {
  subtype?: string
  result_text?: string
}

/** Concatenate the text blocks of an assistant message's content (string content
 *  is returned as-is). tool_use / thinking blocks are ignored -- only prose can
 *  carry a `<callout>`. */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') out += t
    }
  }
  return out
}

export class SotuEmitter {
  private readonly scanner = new CalloutScanner()
  private readonly digest = new TurnDigestCollector()

  constructor(
    private readonly convId: string,
    private readonly send: SotuSend,
  ) {}

  /** Process a LIVE (non-replay) batch of MAIN-THREAD transcript entries. The
   *  caller must NOT pass replay/initial batches (those would re-emit historical
   *  callouts) or subagent entries (those arrive via a separate callback). */
  observeLiveEntries(entries: TranscriptEntry[]): void {
    for (const entry of entries) {
      if (entry.type === 'assistant') this.observeAssistant(entry)
      else if (entry.type === 'user') this.observeUser(entry)
    }
  }

  private observeAssistant(entry: TranscriptEntry): void {
    const content = (entry as { message?: { content?: unknown } }).message?.content
    this.digest.observeAssistantContent(content)
    const text = assistantText(content)
    if (text) this.emitCallouts(text)
  }

  private observeUser(entry: TranscriptEntry): void {
    if ((entry as { isMeta?: boolean }).isMeta) return
    // Only a plain-string user message is a real prompt (the turn's intent);
    // tool_result arrays (array content) are not.
    const content = (entry as { message?: { content?: unknown } }).message?.content
    if (typeof content === 'string' && content.trim()) this.digest.observeUserText(content)
  }

  private emitCallouts(text: string): void {
    for (const c of this.scanner.feed(text)) {
      const payload = c.payload.trim()
      if (!payload) continue
      this.send({
        type: 'scribe_note',
        noteType: c.type,
        payload,
        weight: 'high',
        convId: this.convId,
        ...(c.path ? { target: { kind: 'claim', path: c.path } } : {}),
      })
    }
  }

  /** At turn end: emit the baseline turn-digest (when non-empty) and reset both
   *  the digest collector and the callout scanner for the next turn. */
  flushTurn(result?: SotuTurnResult): void {
    const d = this.digest.build(result)
    if (d) this.send({ type: 'turn_digest', convId: this.convId, ...d })
    this.digest.reset()
    this.scanner.reset()
  }
}
