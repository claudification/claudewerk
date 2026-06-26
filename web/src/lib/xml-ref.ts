/**
 * Generic `<tag id="...">label</tag>` reference codec. The conversation (`:`) and
 * canvas (`!c:`) pills are the same token shape with a different tag name, so the
 * build/parse/match logic lives here once. See conversation-refs.ts / canvas-refs.ts
 * for the per-tag wrappers (which keep their own named types + helpers).
 */

export interface XmlRef {
  /** The `id="..."` attribute value. */
  id: string
  /** The element body (human label). */
  label: string
  /** Byte offset of the opening `<`. */
  start: number
  /** Byte offset just past the closing `>`. */
  end: number
}

export interface XmlRefCodec {
  build(id: string, label: string): string
  parse(text: string): XmlRef[]
  matchLeading(src: string): { raw: string; id: string; label: string } | null
}

/** Build a codec for one tag name (e.g. 'conversation', 'canvas'). The label body
 *  forbids a literal `<` so a malformed/nested tag can't swallow following content. */
export function makeXmlRefCodec(tag: string): XmlRefCodec {
  const globalRe = new RegExp(`<${tag} id="([^"]+)">([^<]*)<\\/${tag}>`, 'g')
  const leadingRe = new RegExp(`^<${tag} id="([^"]+)">([^<]*)<\\/${tag}>`)
  return {
    build: (id, label) => `<${tag} id="${id}">${label}</${tag}>`,
    parse(text) {
      const refs: XmlRef[] = []
      globalRe.lastIndex = 0
      let m: RegExpExecArray | null
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
      while ((m = globalRe.exec(text))) {
        refs.push({ id: m[1], label: m[2], start: m.index, end: m.index + m[0].length })
      }
      return refs
    },
    matchLeading(src) {
      const m = src.match(leadingRe)
      return m ? { raw: m[0], id: m[1], label: m[2] } : null
    },
  }
}
