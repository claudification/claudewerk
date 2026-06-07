/**
 * Decide whether an arbitrary value is structured data worth pretty-printing
 * (object / array, or a string that is actually JSON) versus plain text.
 *
 * Control-command responses come over the wire typed as `unknown`: sometimes an
 * object, sometimes a JSON-encoded string, sometimes just text. This is the one
 * detector the YAML/JSON structured views share.
 */

export type StructuredKind = 'data' | 'text'

export interface Coerced {
  kind: StructuredKind
  /** present when kind === 'data' */
  data?: unknown
  /** present when kind === 'text' */
  text?: string
  /** true when a JSON string was parsed into `data` */
  fromJsonString: boolean
}

export function coerceStructured(input: unknown): Coerced {
  if (input === null || input === undefined) {
    return { kind: 'text', text: String(input), fromJsonString: false }
  }
  if (typeof input === 'object') {
    return { kind: 'data', data: input, fromJsonString: false }
  }
  if (typeof input === 'string') {
    const trimmed = input.trim()
    // Only attempt a parse when it actually looks like a JSON object/array --
    // bare numbers/quoted scalars parse too but are better shown as text.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') {
          return { kind: 'data', data: parsed, fromJsonString: true }
        }
      } catch {
        // not JSON -- fall through to text
      }
    }
    return { kind: 'text', text: input, fromJsonString: false }
  }
  // number, boolean, bigint, symbol, function
  return { kind: 'text', text: String(input), fromJsonString: false }
}
