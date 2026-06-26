/**
 * Streaming `<callout>` scanner -- the AGENT-HOST half of the SOTU emit channel.
 *
 * BOUNDARY: the agent host is the ONLY component allowed to parse CC output (the
 * broker never does -- covenant). This scanner reads assistant text as it streams
 * and emits a COPY of every inline `<callout>` so the host can forward a typed
 * `scribe_note` to the broker. It does NOT strip the callout -- the prose stays
 * whole in the transcript; this is a non-destructive read.
 *
 * The hard case (per the build plan) is a tag SPANNING input boundaries: a
 * callout can arrive split across two `feed()` calls (e.g. `<callout type="ins`
 * then `ight">x</callout>`). The scanner buffers the unconsumed tail and only
 * emits once a complete, valid `<callout>...</callout>` has been seen. Grammar is
 * shared with the web renderer via `matchLeadingCallout` so the two never drift.
 */

import { matchLeadingCallout, type ParsedCallout } from '../shared/sotu-callout'

const TAG_OPEN = '<callout'
const CLOSE_TAG = '</callout>'
// A safety cap so an unterminated `<callout` (the agent opened a tag and never
// closed it) can't grow the buffer without bound. 64 KiB dwarfs any real
// callout; past it we abandon the open tag and resync on the next one.
const MAX_BUFFER = 64 * 1024

/** Longest suffix of `buf` that is a proper prefix of `<callout` -- retained
 *  across feeds so a tag split exactly at the `<callout` token survives. */
function retainPartialTagPrefix(buf: string): string {
  const max = Math.min(buf.length, TAG_OPEN.length - 1)
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(TAG_OPEN.slice(0, n))) return buf.slice(buf.length - n)
  }
  return ''
}

/**
 * Stateful, push-driven callout extractor. Feed it assistant text in any chunking
 * (single complete message OR streaming deltas); it returns the callouts that
 * completed within the accumulated buffer. Construct one per turn (or reuse +
 * `reset()` at each turn boundary).
 */
export class CalloutScanner {
  private buf = ''

  /** Feed a chunk of assistant text; returns any callouts that just completed. */
  feed(chunk: string): ParsedCallout[] {
    if (!chunk) return []
    this.buf += chunk
    const found: ParsedCallout[] = []
    for (;;) {
      const step = this.advance()
      if (step.emit) found.push(step.emit)
      if (step.done) break
    }
    return found
  }

  /** Make one pass over the head of the buffer: drop leading prose, then either
   *  emit a completed callout, skip a false/invalid start, or stop and wait for
   *  more input. Mutates `this.buf`; `done` means there is nothing more to do
   *  until the next `feed()`. */
  private advance(): { emit?: ParsedCallout; done: boolean } {
    const idx = this.buf.indexOf(TAG_OPEN)
    if (idx === -1) {
      // No tag start anywhere; keep only a possible split-boundary prefix.
      this.buf = retainPartialTagPrefix(this.buf)
      return { done: true }
    }
    if (idx > 0) this.buf = this.buf.slice(idx) // drop prose before the tag

    // `<calloutX` (no whitespace/`>` after the token) can never be a callout.
    const after = this.buf[TAG_OPEN.length]
    if (after !== undefined && after !== '>' && !/\s/.test(after)) {
      this.buf = this.buf.slice(1) // skip this false start, resync on the next
      return { done: false }
    }

    const m = matchLeadingCallout(this.buf)
    if (m) {
      this.buf = this.buf.slice(m.raw.length)
      return { emit: m, done: false }
    }

    // Plausible `<callout` start but no complete valid match. If the close tag is
    // already present the tag is closed-but-invalid (bad type), and past the
    // safety cap an unterminated tag is abandoned -- both resync by skipping one
    // char. Otherwise it is still streaming: keep the buffer and wait.
    if (this.buf.includes(CLOSE_TAG) || this.buf.length > MAX_BUFFER) {
      this.buf = this.buf.slice(1)
      return { done: false }
    }
    return { done: true }
  }

  /** Discard any buffered partial tag. Call at a turn boundary. */
  reset(): void {
    this.buf = ''
  }
}
