/**
 * The rule that stops a DSL canvas from saving itself blank.
 *
 * THE WIPE (2026-08-05, Jonas lost drawings to it twice): a draw-dsl scene mounts
 * Excalidraw EMPTY on purpose -- the expansion is async (mermaid parses through a
 * lazy runtime), so the elements arrive later through the imperative API. But
 * Excalidraw fires a settling `onChange` immediately, with zero elements, and the
 * seed baseline for a DSL scene is `null` (there is no scene to fingerprint yet).
 * Zero elements therefore looked like a REAL edit: the debounced flush persisted
 * `elements: []` and broadcast it to every open viewer, who applied the blank and
 * autosaved it over the drawing.
 *
 * The fix is one invariant: while a DSL seed is still in flight, an EMPTY scene is
 * not an edit -- it is the canvas not being ready yet. Once the seed has landed
 * (or if there was never a DSL seed), an empty scene means what it says, so
 * select-all-and-delete still saves.
 *
 * Deliberately NOT solved on the receiving side: a genuine clear arrives as
 * `elements: []` too, so a receiver cannot tell the difference. Only the sender
 * knows its seed is pending.
 */

/** True when this onChange is the pre-seed blank rather than a real edit. */
export function isPreSeedBlank(opts: { dslSeedPending: boolean; elementCount: number }): boolean {
  return opts.dslSeedPending && opts.elementCount === 0
}
