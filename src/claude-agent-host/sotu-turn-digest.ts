/**
 * Per-turn turn-digest collector -- the always-on BASELINE floor of the SOTU
 * contribution spine (Phase 3). Unlike a `<callout>` (voluntary, high-weight),
 * a turn-digest is emitted at the END OF EVERY TURN regardless of whether the
 * agent flagged anything, so the chronicle never depends on voluntary emission.
 *
 * It is a COMPACT summary -- intent + files touched + a short result -- NOT the
 * raw messages. The collector accumulates signals as a turn streams, then
 * `build()`s the digest at turn end (the host forwards it as a `turn_digest`
 * wire message -> `recordContribution`). Pure + side-effect-free so it unit-tests
 * without a live CC stream.
 */

/** Tool calls whose `file_path` means the turn TOUCHED a file. Reads are not
 *  "touches" -- the digest tracks what changed, not what was inspected. */
const TOUCH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_TEXT = 280

function clamp(s: string): string {
  const t = s.trim()
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 3)}...` : t
}

/** True when a content block is a write-ish (file-touching) tool call. */
function isTouchToolUse(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const b = block as { type?: unknown; name?: unknown }
  return b.type === 'tool_use' && typeof b.name === 'string' && TOUCH_TOOLS.has(b.name)
}

/** The file a write-ish tool call touched, or undefined for any other block. */
function touchedFilePath(block: unknown): string | undefined {
  if (!isTouchToolUse(block)) return undefined
  const input = (block as { input?: { file_path?: unknown; notebook_path?: unknown } }).input
  if (typeof input?.file_path === 'string') return input.file_path
  if (typeof input?.notebook_path === 'string') return input.notebook_path
  return undefined
}

/** The compact digest shape (mirrors the wire `TurnDigest` payload fields). */
export interface TurnDigestData {
  intent?: string
  touching?: string[]
  result?: string
}

interface ResultLike {
  subtype?: string
  result_text?: string
}

/** Distill a turn result into a one-line signal: a non-success subtype (error,
 *  max-turns) and/or a trimmed final-text snippet. Returns undefined for a plain
 *  successful turn with no final text. */
function summarizeResult(result?: ResultLike): string | undefined {
  if (!result) return undefined
  const sub = typeof result.subtype === 'string' && result.subtype !== 'success' ? result.subtype : undefined
  const text = typeof result.result_text === 'string' ? clamp(result.result_text) : ''
  if (sub && text) return `${sub}: ${text}`
  return sub || text || undefined
}

export class TurnDigestCollector {
  private intent?: string
  private readonly touched = new Set<string>()

  /** Record the user prompt text that opened/continued the turn (the intent). */
  observeUserText(text: string): void {
    const t = clamp(text)
    if (t) this.intent = t
  }

  /** Scan an assistant message's content blocks for file-touching tool calls. */
  observeAssistantContent(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const block of content) {
      const fp = touchedFilePath(block)
      if (fp) this.touched.add(fp)
    }
  }

  /** Build the digest for the just-ended turn, or null when nothing meaningful
   *  was observed (skip empty baseline noise). */
  build(result?: ResultLike): TurnDigestData | null {
    const touching = [...this.touched]
    const resultText = summarizeResult(result)
    if (!this.intent && touching.length === 0 && !resultText) return null
    return {
      ...(this.intent ? { intent: this.intent } : {}),
      ...(touching.length ? { touching } : {}),
      ...(resultText ? { result: resultText } : {}),
    }
  }

  /** Clear all accumulated state for the next turn. */
  reset(): void {
    this.intent = undefined
    this.touched.clear()
  }
}
