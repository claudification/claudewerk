/**
 * A card's body as one line of readable prose.
 *
 * The old version was `body.split('\n').filter(Boolean).join(' ').slice(0, 600)`
 * -- written twice, in project-card-file.ts and project-card-write.ts -- and it
 * carried raw markdown straight to the panel. Cards rendered as
 * `## Symptom The EPICS view...`, `the **spawn request shape** is duplicated`
 * and `**A**gent-**N**ative **V**isual`, which is harder to read than the low
 * contrast it sat behind.
 *
 * This strips SYNTAX, not content: every rule below removes a marker and keeps
 * the words it wrapped. The one exception is a fenced code block, which is
 * dropped whole -- a preview of someone's TypeScript is not a preview of what
 * the card is about.
 */

/** How much of the body reaches the wire. */
export const BODY_PREVIEW_LIMIT = 600

/** Ordered: fences before lines, links before emphasis. */
const STRIP: Array<[RegExp, string]> = [
  // Fenced code, whole. Non-greedy so two fences do not swallow the prose between.
  [/```[\s\S]*?```/g, ' '],
  [/~~~[\s\S]*?~~~/g, ' '],
  // HTML comments.
  [/<!--[\s\S]*?-->/g, ' '],
  // Images before links -- `![alt](src)` is a link shape with a `!` on it.
  [/!\[[^\]]*\]\([^)]*\)/g, ' '],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  // Line-leading markers: heading, blockquote, list bullet, ordered item.
  [/^[ \t]*#{1,6}[ \t]+/gm, ''],
  [/^[ \t]*>[ \t]?/gm, ''],
  [/^[ \t]*[-*+][ \t]+/gm, ''],
  [/^[ \t]*\d+\.[ \t]+/gm, ''],
  // Horizontal rules, on their own line.
  [/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, ' '],
  // Emphasis. Paired delimiters only, so `2 * 3` and `snake_case` survive.
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/\*([^\s*][^*]*)\*/g, '$1'],
  [/(^|[\s(])_([^\s_][^_]*)_(?=[\s).,;:!?]|$)/g, '$1$2'],
  // Inline code: keep what is inside.
  [/`([^`]+)`/g, '$1'],
]

export function makeBodyPreview(body: string): string {
  let text = body
  for (const [pattern, replacement] of STRIP) text = text.replace(pattern, replacement)
  return text.replace(/\s+/g, ' ').trim().slice(0, BODY_PREVIEW_LIMIT)
}
