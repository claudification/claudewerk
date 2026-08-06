/**
 * MCP commit-ledger tools -- the ledger, for agents.
 *
 *   1. search_commits  -> what landed, filtered by text / path / project /
 *                         conversation / origin
 *   2. commit_context  -> a hash -> the conversation + transcript position that
 *                         produced it (the `git blame` join)
 *
 * Both call the broker over HTTP; the broker enforces permission gating and
 * strips host paths for share-scoped callers.
 */

import type { CommitRow } from '../../../shared/commit-ledger'
import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

interface ListResponse {
  commits: CommitRow[]
  total: number
}

function line(commit: CommitRow): string {
  const who = commit.conversationName || commit.conversationId?.slice(0, 8) || 'terminal'
  const when = new Date(commit.committedAt).toISOString().replace('T', ' ').slice(0, 16)
  const churn = commit.insertions || commit.deletions ? ` +${commit.insertions}/-${commit.deletions}` : ''
  return `${commit.shortHash}  ${when}  ${commit.origin}/${who}  ${commit.branch}  ${commit.subject}${churn}`
}

function formatList(data: ListResponse, showFiles: boolean): string {
  if (data.commits.length === 0) return 'No commits matched.'
  const lines = [`${data.commits.length} of ${data.total} commit(s):`, '']
  for (const commit of data.commits) {
    lines.push(line(commit))
    if (showFiles) for (const f of commit.files) lines.push(`    ${f.status}  ${f.path}`)
  }
  lines.push('')
  lines.push('Drill in: commit_context({ hash }) -> the conversation + transcript position that produced it.')
  return lines.join('\n')
}

export function registerCommitTools(ctx: McpToolContext): Record<string, ToolDef> {
  function authHeaders(): Record<string, string> {
    return ctx.brokerSecret ? { Authorization: `Bearer ${ctx.brokerSecret}` } : {}
  }

  function brokerHttp(): string | null {
    if (ctx.noBroker || !ctx.brokerUrl) return null
    return wsToHttpUrl(ctx.brokerUrl)
  }

  async function get<T>(path: string, label: string): Promise<T | string> {
    const http = brokerHttp()
    if (!http) return 'Error: broker not available'
    try {
      const res = await fetch(`${http}${path}`, { headers: authHeaders() })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        debug(`[channel] ${label}: HTTP ${res.status} ${body.slice(0, 200)}`)
        return `${label} failed (${res.status}): ${body.slice(0, 200) || 'unknown'}`
      }
      return (await res.json()) as T
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      debug(`[channel] ${label} error: ${msg}`)
      return `${label} request failed: ${msg}`
    }
  }

  return {
    search_commits: {
      description:
        'Search the COMMIT LEDGER -- every commit recorded by the git post-commit hook, attributed to the ' +
        'conversation that made it.\n\n' +
        'ANSWERS: what did this conversation actually land? what touched this file, ever, by anyone? ' +
        'which commits mention X? what did a human change versus an agent?\n\n' +
        'FILTERS (combine freely):\n' +
        '  query        -- full text over commit messages AND touched paths\n' +
        '  path         -- substring match on a touched file path\n' +
        '  conversation -- one conversation id\n' +
        '  project      -- project URI (matches the repo root OR a worktree)\n' +
        '  origin       -- "agent" (made inside a conversation) or "human" (a terminal commit)\n\n' +
        'A commit is EVIDENCE: use it to check whether work claimed as done actually landed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Full-text over message + touched paths.' },
          path: { type: 'string', description: 'Substring of a touched file path, e.g. "src/broker/auth".' },
          conversation: { type: 'string', description: 'Limit to one conversation id.' },
          project: { type: 'string', description: 'Limit to one project URI.' },
          origin: { type: 'string', enum: ['agent', 'human'], description: 'Who made it.' },
          files: { type: 'boolean', description: "Include each commit's file list (default false)." },
          limit: { type: 'number', description: 'Max results (1-200, default 30).' },
        },
      },
      async handle(params) {
        const url = new URL('http://x/api/commits')
        if (params.query) url.searchParams.set('q', String(params.query))
        if (params.path) url.searchParams.set('path', String(params.path))
        if (params.conversation) url.searchParams.set('conversation', String(params.conversation))
        if (params.project) url.searchParams.set('project', String(params.project))
        if (params.origin) url.searchParams.set('origin', String(params.origin))
        url.searchParams.set('limit', String(Math.min(Number(params.limit) || 30, 200)))

        const data = await get<ListResponse>(`${url.pathname}${url.search}`, 'search_commits')
        if (typeof data === 'string') return { content: [{ type: 'text', text: data }], isError: true }
        return { content: [{ type: 'text', text: formatList(data, Boolean(params.files)) }] }
      },
    },

    commit_context: {
      description:
        'THE JOIN: a commit hash -> the conversation that made it and the transcript position at the moment ' +
        'it committed.\n\n' +
        '`git blame` gives you a hash; this gives you the REASONING -- the prompt that asked for the change, ' +
        'the tool calls, the failed attempts before the fix. Follow it with ' +
        'get_transcript_context({ conversationId, aroundSeq }) to read the actual window.\n\n' +
        'A full hash or any prefix of 4+ characters works. A commit made at a terminal has no conversation; ' +
        'the reply says so rather than guessing.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          hash: { type: 'string', description: 'Commit hash (full or >=4-char prefix).' },
        },
        required: ['hash'],
      },
      async handle(params) {
        const hash = String(params.hash || '').trim()
        if (hash.length < 4) {
          return { content: [{ type: 'text', text: 'Error: hash must be at least 4 characters' }], isError: true }
        }
        const data = await get<{
          commit: CommitRow
          conversationId: string | null
          anchor: { seq: number; uuid: string; timestamp: number } | null
          reason?: string
        }>(`/api/commits/${encodeURIComponent(hash)}/transcript`, 'commit_context')
        if (typeof data === 'string') return { content: [{ type: 'text', text: data }], isError: true }

        const lines = [line(data.commit), '']
        for (const f of data.commit.files) lines.push(`    ${f.status}  ${f.path}`)
        lines.push('')
        if (!data.conversationId) {
          lines.push(data.reason ?? 'No conversation made this commit.')
        } else {
          lines.push(`conversation: ${data.conversationId}`)
          if (data.anchor) {
            lines.push(`transcript position: seq ${data.anchor.seq}`)
            lines.push(
              `Read it: get_transcript_context({ conversationId: "${data.conversationId}", aroundSeq: ${data.anchor.seq} })`,
            )
          } else {
            lines.push('No transcript entry found near the commit time.')
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      },
    },
  }
}
