import { AlertTriangle, Pencil, RotateCw, X } from 'lucide-react'
import { memo, useState } from 'react'
import { retryOutboxEntry } from '@/hooks/use-conversations'
import { type OutboxEntry, useOutboxStore } from '@/lib/outbox'
import { cn, formatAge, haptic } from '@/lib/utils'

const ROW_BUTTON = 'p-1 rounded text-amber-500/70 hover:text-amber-200 hover:bg-amber-500/20 transition-colors'

function OutboxRow({ entry, onEdit }: { entry: OutboxEntry; onEdit: (text: string) => void }) {
  const remove = useOutboxStore(s => s.remove)
  return (
    <li className="flex items-start gap-2 px-2 py-1.5 border-t border-amber-500/20 first:border-t-0">
      <div className="flex-1 min-w-0">
        <div className="truncate text-amber-100/90">{entry.text}</div>
        <div className="text-[10px] text-amber-500/60">
          {entry.error} - {formatAge(entry.ts)}
          {entry.attempts > 1 && ` - ${entry.attempts} attempts`}
        </div>
      </div>
      <button
        type="button"
        title="Retry"
        className={ROW_BUTTON}
        onClick={() => {
          haptic('tap')
          retryOutboxEntry(entry.conversationId, entry.id)
        }}
      >
        <RotateCw className="size-3.5" />
      </button>
      <button
        type="button"
        title="Move back into the input box"
        className={ROW_BUTTON}
        onClick={() => {
          haptic('tap')
          remove(entry.conversationId, entry.id)
          onEdit(entry.text)
        }}
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        title="Discard"
        className={ROW_BUTTON}
        onClick={() => {
          haptic('tick')
          remove(entry.conversationId, entry.id)
        }}
      >
        <X className="size-3.5" />
      </button>
    </li>
  )
}

/**
 * Undelivered messages for this conversation, held for explicit retry.
 * Nothing is ever re-sent automatically -- see `@/lib/outbox`.
 */
export const OutboxBar = memo(function OutboxBar({
  conversationId,
  onEdit,
}: {
  conversationId: string
  onEdit: (text: string) => void
}) {
  const entries = useOutboxStore(s => s.entries[conversationId])
  const clear = useOutboxStore(s => s.clear)
  const [collapsed, setCollapsed] = useState(false)

  if (!entries || entries.length === 0) return null

  return (
    <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 font-mono text-xs">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <AlertTriangle className="size-3.5 text-amber-500 shrink-0" />
        <button
          type="button"
          className="flex-1 text-left text-amber-300 cursor-pointer hover:text-amber-200 transition-colors"
          onClick={() => setCollapsed(c => !c)}
        >
          {entries.length} message{entries.length > 1 ? 's' : ''} not delivered
          <span className="ml-2 text-amber-500/60 text-[10px]">{collapsed ? 'show' : 'hide'}</span>
        </button>
        {entries.length > 1 && (
          <button
            type="button"
            className={cn(ROW_BUTTON, 'px-1.5 text-[10px] font-bold')}
            onClick={() => {
              haptic('tap')
              for (const e of [...entries]) retryOutboxEntry(conversationId, e.id)
            }}
          >
            RETRY ALL
          </button>
        )}
        <button
          type="button"
          title="Discard all"
          className={ROW_BUTTON}
          onClick={() => {
            haptic('tick')
            clear(conversationId)
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {!collapsed && (
        <ul className="max-h-40 overflow-y-auto">
          {entries.map(entry => (
            <OutboxRow key={entry.id} entry={entry} onEdit={onEdit} />
          ))}
        </ul>
      )}
    </div>
  )
})
