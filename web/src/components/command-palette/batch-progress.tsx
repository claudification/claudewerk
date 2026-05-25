import { extractProjectLabel } from '@shared/project-uri'
import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import type { BatchAction, BatchActionRunResult } from './batch-actions'

function RowStatusIcon({ row }: { row: RowState | undefined }) {
  if (!row?.settledAt) {
    return (
      <span className="w-3 h-3 inline-block rounded-full border-2 border-muted-foreground/40 border-t-transparent animate-spin" />
    )
  }
  return row.ok ? (
    <Check className="w-3 h-3 text-active shrink-0" />
  ) : (
    <X className="w-3 h-3 text-destructive shrink-0" />
  )
}

function ProgressRow({
  conversationId,
  row,
  conv,
}: {
  conversationId: string
  row: RowState | undefined
  conv: Conversation | undefined
}) {
  const label = conv?.title || (conv ? extractProjectLabel(conv.project) : conversationId.slice(0, 8))
  const dur = row?.settledAt && row.startedAt ? row.settledAt - row.startedAt : null
  const detail = row?.error ? row.error : (row?.detail ?? (row?.settledAt ? '' : 'pending'))
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <RowStatusIcon row={row} />
      <span className="truncate w-40 shrink-0" title={conversationId}>
        {label}
      </span>
      <span className="flex-1 truncate text-muted-foreground/70">{detail}</span>
      {dur !== null && <span className="text-[10px] text-muted-foreground/50 tabular-nums">{dur}ms</span>}
    </div>
  )
}

interface BatchProgressProps {
  action: BatchAction
  conversationIds: string[]
  batchId: string
  input: unknown
  onRetry: (failedIds: string[]) => void
  onClose: () => void
}

interface RowState extends BatchActionRunResult {
  startedAt: number
  settledAt?: number
}

export function BatchProgress({ action, conversationIds, batchId, input, onRetry, onClose }: BatchProgressProps) {
  const conversationsById = useConversationsStore(s => s.conversationsById)
  const [rows, setRows] = useState<Map<string, RowState>>(() => {
    const seed = new Map<string, RowState>()
    const t = Date.now()
    for (const id of conversationIds) seed.set(id, { conversationId: id, ok: false, startedAt: t })
    return seed
  })
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    ;(async () => {
      const convs = conversationIds
        .map(id => conversationsById[id])
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
      const stream = action.run({ ids: conversationIds, conversations: convs, batchId, input })
      for await (const res of stream) {
        setRows(prev => {
          const next = new Map(prev)
          const prior = next.get(res.conversationId)
          next.set(res.conversationId, {
            ...res,
            startedAt: prior?.startedAt ?? Date.now(),
            settledAt: Date.now(),
          })
          return next
        })
      }
    })().catch(err => {
      console.error('[batch-progress] stream error', err)
    })
    // We intentionally start once per mount; action/ids/batchId are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const settled = Array.from(rows.values()).filter(r => r.settledAt)
  const failedIds = settled.filter(r => !r.ok).map(r => r.conversationId)
  const total = conversationIds.length

  return (
    <div className="font-mono text-xs">
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="flex items-center gap-3">
          <span className="text-accent font-bold">{action.label}</span>
          <span className="text-muted-foreground text-[10px]">{batchId}</span>
          <span className="text-muted-foreground/70 text-[10px]">
            {settled.length}/{total} settled
          </span>
        </div>
        <div className="flex items-center gap-2">
          {failedIds.length > 0 && settled.length === total && (
            <button
              type="button"
              onClick={() => onRetry(failedIds)}
              className="px-2 py-1 text-[10px] bg-amber-500/15 border border-amber-500/40 text-amber-400 hover:bg-amber-500/25 transition-colors"
            >
              Retry failures ({failedIds.length})
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 text-[10px] bg-muted/30 hover:bg-muted/50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
      <div className="max-h-[40vh] overflow-y-auto divide-y divide-border/40">
        {conversationIds.map(id => (
          <ProgressRow key={id} conversationId={id} row={rows.get(id)} conv={conversationsById[id]} />
        ))}
      </div>
    </div>
  )
}
