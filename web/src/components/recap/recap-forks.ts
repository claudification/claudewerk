/**
 * Write-up A/B helpers: the curated model dropdown set + the fork-switcher
 * grouping.
 *
 * Lineage source = Option A (web-only): the recap row has no source_recap_id
 * column, so we group variants by projectUri + period. Every fork copies the
 * source's project + exact period, so the same-period set IS the variant set
 * (loose only if an unrelated recap of the identical period exists -- fine for
 * a manual eval tool). The synthesize override accepts ANY OpenRouter slug, so
 * the curated list is a convenience, not a constraint.
 */

import type { RecapSummary } from '@shared/protocol'
import { appendShareParam } from '@/lib/share-mode'

export interface RecapModelOption {
  /** OpenRouter slug passed straight to recap_regenerate's `model`. */
  slug: string
  label: string
}

// All verified live on OpenRouter (2026-07-03). Opus 4.8 is the prod reduce
// default and leads the list. A synthesize override accepts ANY OpenRouter
// slug, so this curated set is a convenience, not a constraint.
export const RECAP_MODEL_OPTIONS: RecapModelOption[] = [
  { slug: 'anthropic/claude-opus-4.8', label: 'Opus 4.8' },
  { slug: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
  { slug: 'anthropic/claude-haiku-4.5', label: 'Haiku 4.5' },
  { slug: 'z-ai/glm-5.2', label: 'GLM-5.2' },
  { slug: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { slug: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { slug: 'x-ai/grok-4.3', label: 'Grok 4.3' },
  { slug: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { slug: 'qwen/qwen3-max', label: 'Qwen3 Max' },
]

export const DEFAULT_RECAP_MODEL = RECAP_MODEL_OPTIONS[0].slug

/** Human label for a slug -- falls back to the slug's tail for off-list models
 *  (e.g. a fork made via MCP with an arbitrary slug). */
export function modelLabel(slug: string | undefined): string {
  if (!slug) return 'pending'
  const known = RECAP_MODEL_OPTIONS.find(o => o.slug === slug)
  if (known) return known.label
  return slug.includes('/') ? (slug.split('/').pop() ?? slug) : slug
}

export interface ForkAnchor {
  recapId: string
  projectUri: string
  periodStart: number
  periodEnd: number
}

/** Siblings = every recap sharing the anchor's project + exact period (the
 *  variant set under Option A). Sorted oldest-first so the original leads and
 *  later forks trail it chronologically. The anchor itself is included when
 *  present in the list. */
export function selectSiblings(list: RecapSummary[], anchor: ForkAnchor): RecapSummary[] {
  return list
    .filter(
      r =>
        r.projectUri === anchor.projectUri && r.periodStart === anchor.periodStart && r.periodEnd === anchor.periodEnd,
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Fetch recaps for a project (or all when omitted) over the REST API. Shared
 *  by the fork switcher and the history modal so the list shape lives in one
 *  place. */
export async function fetchRecapList(projectUri?: string): Promise<RecapSummary[]> {
  const url = new URL('/api/recaps', window.location.origin)
  if (projectUri) url.searchParams.set('projectUri', projectUri)
  url.searchParams.set('limit', '100')
  const res = await fetch(appendShareParam(url.pathname + url.search))
  if (!res.ok) return []
  const body = (await res.json()) as { recaps?: RecapSummary[] }
  return body.recaps ?? []
}
