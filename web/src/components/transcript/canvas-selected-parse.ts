/**
 * Split a canvas chat message into "what was selected" and "what was said".
 *
 * The wire format is deliberate: the agent needs the selection as literal
 * `<selected id=... />` lines it can read ids out of (see
 * src/shared/canvas-selection.ts). The TRANSCRIPT does not -- rendering that
 * markup raw in a chat bubble is just XML in the user's face. So the renderer
 * parses the same lines back into chips, and the untouched text is what remains.
 *
 * Parsing, not re-deriving: the broker never sends the structured selection to
 * the panel, only this rendered block. Reading it back is the cheap half of the
 * round trip -- the alternative is a wire change across host + broker.
 */

/** One selected element, as much of it as the wire line carried. */
export interface SelectedChip {
  id: string
  type: string
  /** The element's own text, when it had any ("CLAUDE" for a labelled box). */
  label?: string
  stroke?: string
  fill?: string
}

export interface ParsedCanvasMessage {
  /** The message with the selection lines removed. */
  text: string
  chips: SelectedChip[]
  /** Set instead of `chips` when the selection was too big to list. */
  census?: { count: number; summary: string }
}

const SELECTED_LINE = /^[ \t]*<selected\b([^>]*?)(?:\/>|>([\s\S]*?)<\/selected>)[ \t]*$/gm

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? unescapeXml(m[1]) : undefined
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** Pull the `<selected>` lines out of a canvas message body. */
export function parseCanvasMessage(body: string): ParsedCanvasMessage {
  const chips: SelectedChip[] = []
  let census: ParsedCanvasMessage['census']

  const text = body
    .replace(SELECTED_LINE, (_line, rawAttrs: string, inner: string | undefined) => {
      const attrs = rawAttrs ?? ''
      const count = attr(attrs, 'count')
      const summary = attr(attrs, 'summary')
      if (count !== undefined) {
        census = { count: Number(count) || 0, summary: summary ?? '' }
        return ''
      }
      const id = attr(attrs, 'id')
      if (!id) return '' // malformed -- drop the noise rather than print it
      const label = inner ? unescapeXml(inner).trim() : ''
      chips.push({
        id,
        type: attr(attrs, 'type') ?? 'element',
        label: label || undefined,
        stroke: attr(attrs, 'stroke'),
        fill: attr(attrs, 'fill'),
      })
      return ''
    })
    .trim()

  return { text, chips, census }
}

/** `canvas:cnv_...` is the sink address a canvas sends from; the id is what the
 *  panel needs to link back to it. Returns null for anything else. */
export function canvasIdFromChannelAddress(address: string | undefined): string | null {
  if (!address) return null
  const m = address.match(/^canvas:(.+)$/)
  return m ? m[1] : null
}
