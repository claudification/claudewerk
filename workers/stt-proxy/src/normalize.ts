/**
 * normalize - collapse two different Workers AI speech APIs into ONE message the
 * browser consumes, so the client never branches on which model is selected.
 *
 * This is the whole reason a model selector is possible. nova-3 speaks Deepgram
 * v1 (`Results`, segment deltas, `speech_final`); flux speaks turns (`TurnInfo`,
 * a CUMULATIVE per-turn transcript, `end_of_turn_confidence`). Left raw, every
 * consumer would need both dialects and would eventually get flux's cumulative
 * transcript wrong by appending it.
 *
 * THE CONTRACT: `text` is always the FULL text of the current segment/turn, and
 * `committed` is everything finished before it. The client renders
 * `committed + text` and never appends anything itself. That single rule is what
 * makes flux's cumulative transcript and nova-3's deltas interchangeable.
 *
 * PARAGRAPHS: a finished flux turn ends with a blank line, so a long dictation
 * comes back as paragraphs instead of one wall of text. A turn boundary is a
 * PARAGRAPH break and never a submit -- with push-to-talk the key release is the
 * only thing that ends an utterance. (See notes in session.ts.)
 */

export interface TranscriptFrame {
  type: 'transcript'
  /** Full text of the segment/turn in flight. Never a fragment to append. */
  text: string
  /** Everything already finalised, joined. Render `committed + text`. */
  committed: string
  /** This segment/turn is done. NOT a signal to submit. */
  final: boolean
  /** Audio position decoded to, ms -- the client's lag meter reads this. */
  audioEndMs: number
  /** flux only: live confidence that the speaker has finished. */
  endOfTurnConfidence?: number
}

export interface UpstreamEvent {
  frame?: TranscriptFrame
  /** Upstream says the stream is finished and everything has been delivered. */
  done?: boolean
  /** Upstream reported a problem worth surfacing. */
  error?: string
}

/** Accumulates finished segments so `committed` is correct across the session. */
export class TranscriptAccumulator {
  private committed: string[] = []
  /** flux restarts `transcript` at each new turn; track which turn is in flight. */
  private turnIndex = -1
  /** The in-flight flux turn, so a release mid-turn does not lose it. */
  private lastTurnText = ''

  private commit(text: string, separator: string) {
    if (!text) return
    this.committed.push(text + separator)
  }

  get committedText(): string {
    return this.committed.join('')
  }

  /** nova-3: `Results` carries a delta; a final one is committed verbatim. */
  // CRAP is inflated by a ZERO-COVERAGE ESTIMATE; normalize.test.ts covers this.
  // fallow-ignore-next-line complexity
  v1(msg: Record<string, unknown>): UpstreamEvent | null {
    const alternatives = (msg.channel as { alternatives?: Array<{ transcript?: string }> } | undefined)?.alternatives
    const text = alternatives?.[0]?.transcript ?? ''
    const final = msg.is_final === true
    if (!text && !final) return null
    // Frame BEFORE commit: `committed` must describe the state this frame's
    // `text` sits on top of, not the state after absorbing it. Commit first and
    // the client renders the final segment twice.
    const frame: TranscriptFrame = {
      type: 'transcript',
      text,
      committed: this.committedText,
      final,
      audioEndMs: Math.round((num(msg.start) + num(msg.duration)) * 1000),
    }
    if (final) this.commit(text, ' ')
    return { frame }
  }

  /**
   * A new turn index means the previous turn ended. Closing it here guards
   * against a DROPPED `EndOfTurn`, which would otherwise silently merge two
   * turns into one run-on paragraph.
   */
  private closeStaleTurn(index: number) {
    const stale = this.turnIndex !== -1 && index !== this.turnIndex && this.lastTurnText
    if (stale) {
      this.commit(this.lastTurnText, '\n\n')
      this.lastTurnText = ''
    }
    this.turnIndex = index
  }

  /**
   * flux: `transcript` is the whole turn so far. On `EndOfTurn` the turn is
   * committed with a paragraph break; the next turn starts from empty.
   */
  // Zero-coverage CRAP estimate; covered incl. dropped-EndOfTurn + release-mid-turn.
  // fallow-ignore-next-line complexity
  turn(msg: Record<string, unknown>): UpstreamEvent | null {
    this.closeStaleTurn(num(msg.turn_index))
    const text = (msg.transcript as string) ?? ''
    if (!text) return null

    const final = msg.event === 'EndOfTurn'
    const confidence = msg.end_of_turn_confidence
    const frame: TranscriptFrame = {
      type: 'transcript',
      text,
      committed: this.committedText,
      final,
      audioEndMs: Math.round(num(msg.audio_window_end) * 1000),
      endOfTurnConfidence: typeof confidence === 'number' ? confidence : undefined,
    }
    if (final) this.commit(text, '\n\n')
    this.lastTurnText = final ? '' : text
    return { frame }
  }

  /** Everything captured, tidied. What the client submits on key release. */
  finalText(): string {
    if (this.lastTurnText) {
      this.commit(this.lastTurnText, '')
      this.lastTurnText = ''
    }
    return this.committedText.trim()
  }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

type Handler = (acc: TranscriptAccumulator, msg: Record<string, unknown>) => UpstreamEvent | null

/** Upstream message type -> what it means. Unknown types are ignored, so a
 *  vendor adding an event cannot break the pipe. */
const HANDLERS: Record<string, Handler> = {
  Results: (acc, msg) => acc.v1(msg),
  TurnInfo: (acc, msg) => acc.turn(msg),
  // v1's guaranteed last word after CloseStream.
  Metadata: () => ({ done: true }),
  // flux's ready signal; nothing to forward.
  Connected: () => null,
  Error: (_acc, msg) => ({ error: String(msg.description ?? msg.code ?? 'upstream error') }),
}

// Zero-coverage CRAP estimate: a parse guard plus a handler-map lookup, tested.
// fallow-ignore-next-line complexity
export function normalize(acc: TranscriptAccumulator, raw: string): UpstreamEvent | null {
  let msg: Record<string, unknown> & { type?: string }
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  return HANDLERS[msg.type ?? '']?.(acc, msg) ?? null
}
