/**
 * `!c:` canvas-reference completer. Fully INDEPENDENT of the `:` conversation
 * source (registered as its own entry in the autocompletion `override` array),
 * so it can never affect normal typing or the conversation popup.
 *
 * Trigger: `!c:<query>` at doc start or after whitespace. On match it ASYNC-fetches
 * the current project's canvases (short-TTL cached), fuzzy-filters by the query, and
 * offers options that insert a `<canvas id="...">name</canvas>` token (lib/canvas-refs).
 * The raw token stays in the doc (that's what's sent); a pill widget + the transcript
 * renderer show the name.
 */

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { CanvasSummary } from '@shared/protocol'
import { useConversationsStore } from '@/hooks/use-conversations'
import { buildCanvasRef } from '@/lib/canvas-refs'
import { appendShareParam } from '@/lib/share-mode'
import { fuzzyScore } from '../../autocomplete-shared'

/** Project URI of the conversation the input belongs to, or undefined. */
function currentProjectUri(): string | undefined {
  const { selectedConversationId, conversationsById } = useConversationsStore.getState()
  return selectedConversationId ? conversationsById[selectedConversationId]?.project : undefined
}

/** Scan backward for a `!c:` trigger. Returns the `!` offset + query, or null. */
export function scanCanvasTrigger(text: string, pos: number): { start: number; query: string } | null {
  const m = text.slice(0, pos).match(/(?:^|\s)!c:([^\s<]*)$/)
  if (!m) return null
  const query = m[1]
  return { start: pos - 3 - query.length, query }
}

// Short-TTL fetch cache so typing within one completion session hits the network once.
const CACHE_TTL_MS = 4000
const cache = new Map<string, { at: number; canvases: CanvasSummary[] }>()

async function fetchCanvases(projectUri: string, now: number): Promise<CanvasSummary[]> {
  const hit = cache.get(projectUri)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.canvases
  const url = `/api/canvases?projectUri=${encodeURIComponent(projectUri)}`
  const res = await fetch(appendShareParam(url))
  if (!res.ok) return hit?.canvases ?? []
  const canvases = ((await res.json()) as { canvases?: CanvasSummary[] }).canvases ?? []
  cache.set(projectUri, { at: now, canvases })
  return canvases
}

function canvasAge(updatedAt: number, now: number): string {
  const mins = Math.floor((now - updatedAt) / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** Async completion source for the `!c:` canvas trigger. */
export async function canvasCompletionSource(context: CompletionContext): Promise<CompletionResult | null> {
  const text = context.state.doc.toString()
  const hit = scanCanvasTrigger(text, context.pos)
  if (!hit) return null
  const projectUri = currentProjectUri()
  if (!projectUri) return null

  const now = Date.now()
  const canvases = await fetchCanvases(projectUri, now)
  if (canvases.length === 0) return null

  const q = hit.query.toLowerCase()
  const scored = canvases.flatMap(c => {
    const score = q ? fuzzyScore(q, c.name.toLowerCase()) : 1
    return score > 0 ? [{ c, score }] : []
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
  if (scored.length === 0) return null

  return {
    from: hit.start, // replace the whole `!c:query` with the token
    to: context.pos,
    options: scored.map(({ c }) => ({
      label: c.name,
      detail: canvasAge(c.updatedAt, now),
      // Trailing space so the caret lands clear of the atomic pill.
      apply: `${buildCanvasRef(c.id, c.name)} `,
    })),
    filter: false,
  }
}
