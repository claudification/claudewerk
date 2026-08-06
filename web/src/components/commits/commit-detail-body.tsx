/**
 * Everything the ledger knows about one commit -- message, files, diffstat,
 * where it ran, and the way back into the conversation that produced it.
 */

import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type CommitRow, commitTypeColor } from '@/lib/commits'
import { appendShareParam } from '@/lib/share-mode'
import { cn, haptic } from '@/lib/utils'
import { CommitTranscriptLinkRow } from './commit-transcript-link'

/** Only fields worth a row. A blank host or container says nothing, and a share
 *  guest gets them stripped server-side anyway -- so absent means absent. */
function facts(commit: CommitRow): Array<[string, string]> {
  return (
    [
      ['branch', commit.branch],
      ['host', commit.host],
      ['container', commit.container],
      ['profile', commit.profile ?? ''],
      ['author', commit.authorName],
      ['origin', commit.origin],
      ['kind', commit.kind],
      [
        'parents',
        commit.parentHashes
          .split(/\s+/)
          .filter(Boolean)
          .map(h => h.slice(0, 8))
          .join(' '),
      ],
    ] as Array<[string, string]>
  ).filter(([, value]) => value)
}

export function CommitDetailBody({ hash }: { hash: string }) {
  const [commit, setCommit] = useState<CommitRow | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setCommit(null)
    setMissing(false)
    void fetch(appendShareParam(`/api/commits/${encodeURIComponent(hash)}`))
      .then(res => (res.ok ? res.json() : null))
      .then((body: { commit?: CommitRow } | null) => {
        if (cancelled) return
        if (body?.commit) setCommit(body.commit)
        else setMissing(true)
      })
      .catch(() => !cancelled && setMissing(true))
    return () => {
      cancelled = true
    }
  }, [hash])

  if (missing) return <div className="text-[11px] text-muted-foreground">No commit matches {hash}.</div>
  if (!commit) return <div className="text-[11px] text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{commit.shortHash}</span>
          <span className="text-[10px] text-muted-foreground/50">{new Date(commit.committedAt).toLocaleString()}</span>
        </div>
        <h2 className={cn('text-sm font-medium', commitTypeColor(commit.ccType))}>{commit.subject}</h2>
        {commit.body && (
          <pre className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-sans pt-1">
            {commit.body}
          </pre>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {facts(commit).map(([label, value]) => (
          <div key={label} className="text-[10px]">
            <span className="text-muted-foreground/50 uppercase tracking-wide">{label} </span>
            <span className="font-mono">{value}</span>
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
          <span>
            {commit.fileCount} file{commit.fileCount === 1 ? '' : 's'}
          </span>
          <span className="text-emerald-400/70">+{commit.insertions}</span>
          <span className="text-rose-400/70">-{commit.deletions}</span>
        </div>
        <div className="space-y-0.5 max-h-[40vh] overflow-y-auto">
          {commit.files.map(f => (
            <div key={`${f.status}:${f.path}`} className="flex items-center gap-2 text-[10px] font-mono">
              <span className="w-8 shrink-0 text-muted-foreground/60">{f.status}</span>
              <span className="truncate">{f.path}</span>
            </div>
          ))}
        </div>
        {commit.filesTruncated && (
          <div className="text-[10px] text-amber-400/70">
            showing 500 of {commit.fileCount} files (the rest were not stored)
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-border space-y-1">
        {commit.conversationId ? (
          <CommitTranscriptLinkRow
            hash={commit.hash}
            conversationId={commit.conversationId}
            conversationName={commit.conversationName}
          />
        ) : (
          <div className="text-[10px] text-muted-foreground">
            Made at a terminal, outside any conversation -- there is no transcript to open.
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            useConversationsStore.getState().selectProject(commit.repoUri)
          }}
          className="text-[10px] text-accent hover:underline"
        >
          Open the project
        </button>
      </div>
    </div>
  )
}
