/**
 * Decode HTML entities in a plain-text string (e.g. `&quot;` -> `"`).
 *
 * Dialog titles are authored by the agent and rendered as RAW text (not through
 * the markdown pipeline, which decodes entities for free via the browser). An
 * agent that HTML-escapes a quote in the title (`("Overwatch")` ->
 * `(&quot;Overwatch&quot;)`) would otherwise show the literal entity. This
 * decodes them using the browser's own parser -- no entity table to maintain.
 *
 * Control panel is a client-only SPA, so `document` always exists. The early
 * return keeps the common (no-entity) path allocation-free.
 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  const el = document.createElement('textarea')
  el.innerHTML = s
  return el.value
}
