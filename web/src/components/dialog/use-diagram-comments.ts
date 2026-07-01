/**
 * use-diagram-comments -- node-level commenting for a live-dialog mermaid block.
 *
 * Mermaid renders each node as `<g class="node" id="A">` where the id is the
 * source identifier the agent wrote (`A[Start]` -> id `A`). We:
 *  - delegate clicks in CAPTURE phase so a node click opens the comment popover
 *    and stopPropagation()s before it reaches markdown.tsx's zoom delegate
 *    (empty-space clicks fall through and still open the zoom lightbox);
 *  - mark commented nodes (.has-comment) whenever the SVG (re)renders -- mermaid
 *    paints async and re-paints on every agent redraw, so we watch via a
 *    MutationObserver and re-apply.
 *
 * Notes live in form state as `values[id] = { nodeId: note }` and round-trip to
 * the agent on submit unchanged (DialogFormState.setValue takes any value).
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { DialogFormState } from './dialog-renderer'

export interface ActiveNode {
  nodeId: string
  label: string
  /** Viewport rect of the clicked node, for fixed-positioning the popover. */
  rect: DOMRect
}

/** The node's stable key: prefer data-id, else the raw id (beautiful-mermaid emits the source id). */
function nodeKey(g: Element): string {
  return g.getAttribute('data-id') || g.getAttribute('id') || ''
}

function nodeLabel(g: Element): string {
  const text = (g.querySelector('.nodeLabel, text, foreignObject') as HTMLElement | null)?.textContent?.trim()
  return text || nodeKey(g)
}

/**
 * Pure merge for one node's note. Empty/whitespace removes the key; when no
 * notes remain we return undefined so the diagram's form value clears entirely
 * (keeps the submit payload clean -- no empty `{}` object).
 */
export function nextComments(
  prev: Record<string, string> | undefined,
  nodeId: string,
  text: string,
): Record<string, string> | undefined {
  const next = { ...(prev ?? {}) }
  if (text.trim()) next[nodeId] = text
  else delete next[nodeId]
  return Object.keys(next).length ? next : undefined
}

// react-doctor-disable-next-line react-doctor/no-derived-state -- comments is derived inline from form.values; active is user-interaction state
export function useDiagramComments(containerRef: RefObject<HTMLElement | null>, id: string, form: DialogFormState) {
  const comments = (form.values[id] as Record<string, string> | undefined) ?? {}
  const [active, setActive] = useState<ActiveNode | null>(null)

  // Keep the latest comment keys in a ref so the MutationObserver callback (set
  // up once) always marks against current state without re-subscribing.
  const keysRef = useRef<string[]>([])
  keysRef.current = Object.keys(comments)

  const applyMarkers = useCallback(() => {
    const root = containerRef.current
    if (!root) return
    const keys = keysRef.current
    for (const g of root.querySelectorAll('g.node')) {
      g.classList.toggle('has-comment', keys.includes(nodeKey(g)))
    }
  }, [containerRef])

  // Capture-phase click: node -> comment (and swallow so zoom never fires).
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    const g = (e.target as Element).closest('g.node')
    if (!g) return // empty space -> let it bubble to the zoom delegate
    e.preventDefault()
    e.stopPropagation()
    setActive({ nodeId: nodeKey(g), label: nodeLabel(g), rect: g.getBoundingClientRect() })
  }, [])

  const setNote = useCallback(
    (nodeId: string, text: string) => {
      form.setValue(id, nextComments(form.values[id] as Record<string, string> | undefined, nodeId, text))
    },
    [form, id],
  )

  const close = useCallback(() => setActive(null), [])

  // Re-mark when the SVG appears or the agent redraws it (async paint).
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    applyMarkers()
    const obs = new MutationObserver(() => applyMarkers())
    obs.observe(root, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [containerRef, applyMarkers])

  // Re-mark immediately when the user's own comment set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on comment-key change
  useEffect(() => {
    applyMarkers()
  }, [applyMarkers, comments])

  return { active, onClickCapture, setNote, close, currentNote: active ? (comments[active.nodeId] ?? '') : '' }
}
