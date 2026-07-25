/**
 * "Watch every group box, including the ones that arrive later."
 *
 * Two mechanisms in the plain renderer need exactly this: the above-viewport
 * anchor (compensate inflation above the reader) and the height recorder (feed
 * real heights back into the shared size cache). Groups mount and unmount as
 * the progressive window moves, so a one-shot querySelectorAll misses every
 * backfilled group -- hence the MutationObserver. Dead nodes drop out of the
 * ResizeObserver automatically.
 */

const GROUP_SELECTOR = '.transcript-plain-group'

export function observeGroupBoxes(
  content: HTMLElement,
  onResize: (entries: ResizeObserverEntry[]) => void,
): () => void {
  const ro = new ResizeObserver(onResize)
  for (const el of content.querySelectorAll(GROUP_SELECTOR)) ro.observe(el)
  const mo = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches(GROUP_SELECTOR)) ro.observe(node)
        for (const el of node.querySelectorAll(GROUP_SELECTOR)) ro.observe(el)
      }
    }
  })
  mo.observe(content, { childList: true, subtree: true })
  return () => {
    ro.disconnect()
    mo.disconnect()
  }
}
