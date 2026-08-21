/**
 * Commit ledger client -- fetch helpers for /api/commits.
 *
 * Types come from `@shared/commit-ledger`, the SAME module the broker's store
 * uses, so the wire shape can never drift between the two halves.
 */

import type { CommitRow } from '@shared/commit-ledger'
import { fetchJsonTimed } from '@/lib/net-timing'
import { appendShareParam } from '@/lib/share-mode'

export type { CommitOrigin, CommitRow } from '@shared/commit-ledger'

export interface CommitListParams {
  conversationId?: string
  projectUris?: string[]
  text?: string
  path?: string
  limit?: number
}

interface ListResponse {
  commits?: CommitRow[]
  total?: number
}

export interface CommitList {
  commits: CommitRow[]
  total: number
}

export async function fetchCommits(params: CommitListParams, signal?: AbortSignal): Promise<CommitList> {
  const url = new URL('/api/commits', window.location.origin)
  if (params.conversationId) url.searchParams.set('conversation', params.conversationId)
  for (const uri of params.projectUris ?? []) url.searchParams.append('project', uri)
  if (params.text) url.searchParams.set('q', params.text)
  if (params.path) url.searchParams.set('path', params.path)
  url.searchParams.set('limit', String(params.limit ?? 100))

  const body = await fetchJsonTimed<ListResponse>('commits.list', appendShareParam(url.pathname + url.search), {
    signal,
  })
  return { commits: body?.commits ?? [], total: body?.total ?? 0 }
}

export interface CommitTranscriptLink {
  conversationId: string | null
  anchor: { seq: number; uuid: string; timestamp: number } | null
}

/** THE JOIN: a hash -> the conversation and the transcript position at the
 *  moment it committed. `git blame` gives the hash; this gives the reasoning. */
export async function fetchCommitTranscript(hash: string): Promise<CommitTranscriptLink | null> {
  const res = await fetch(appendShareParam(`/api/commits/${encodeURIComponent(hash)}/transcript`))
  if (!res.ok) return null
  return (await res.json()) as CommitTranscriptLink
}

export function commitAge(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Colour per conventional-commit type. Unknown types fall through to neutral
 *  rather than inventing a colour per new prefix someone types. */
const TYPE_COLORS: Record<string, string> = {
  feat: 'text-emerald-400',
  fix: 'text-rose-400',
  refactor: 'text-violet-400',
  docs: 'text-sky-400',
  test: 'text-amber-400',
  chore: 'text-muted-foreground',
  perf: 'text-orange-400',
}

export function commitTypeColor(ccType: string | null): string {
  return (ccType && TYPE_COLORS[ccType]) || 'text-muted-foreground'
}
