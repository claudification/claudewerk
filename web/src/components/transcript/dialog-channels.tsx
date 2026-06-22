import { RotateCcw, Send } from 'lucide-react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from '../markdown'
import type { RenderItem } from './group-view-types'

type ChannelRenderItem = Extract<RenderItem, { kind: 'channel' }>

/** Parse a JSON string into key/value pairs for DialogValues; [] if not an object. */
function valueEntries(text: string): Array<[string, unknown]> {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) return Object.entries(parsed)
  } catch {
    /* not JSON, caller falls back to text */
  }
  return []
}

/** A one-shot dialog RESULT delivered back to the agent (sender="dialog"). */
export function DialogChannel({ item }: { item: ChannelRenderItem }) {
  const statusStyles: Record<string, string> = {
    submitted: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    cancelled: 'bg-zinc-500/15 text-muted-foreground border-zinc-500/20',
    timeout: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  }
  const sStyle = statusStyles[item.dialogStatus || 'submitted'] || statusStyles.submitted

  // A cancelled/timed-out dialog whose layout is still held live (the broker
  // keeps it re-displayable) can be re-triggered: re-open the same modal and
  // answer it late. Only show the button when this exact dialog is still the
  // active pending one for the selected conversation -- otherwise it's a dead end.
  const dialogId = item.dialogId
  const canReopen = useConversationsStore(s => {
    if (!dialogId) return false
    const cid = s.selectedConversationId
    return !!(cid && s.pendingDialogs[cid]?.dialogId === dialogId)
  })
  const reopenable = canReopen && (item.dialogStatus === 'cancelled' || item.dialogStatus === 'timeout')
  const userValues = valueEntries(item.text)

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 my-1">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-mono text-violet-400/60">dialog</span>
        <span className={cn('px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded', sStyle)}>
          {item.dialogStatus || 'submitted'}
        </span>
        {item.dialogAction && (
          <span className="px-1.5 py-0.5 bg-violet-500/20 text-violet-400 border border-violet-500/30 rounded text-[9px] font-bold">
            {item.dialogAction}
          </span>
        )}
        {reopenable && (
          <button
            type="button"
            onClick={() => {
              haptic('tap')
              window.dispatchEvent(new CustomEvent('rclaude-dialog-reopen', { detail: { dialogId } }))
            }}
            title="Re-display this dialog and answer it (delivered to the agent as a late answer)"
            className="ml-auto flex items-center gap-1 rounded border border-violet-500/40 bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-300 hover:bg-violet-500/25 transition-colors"
          >
            <RotateCcw className="size-3" />
            Re-trigger
          </button>
        )}
      </div>
      {userValues.length > 0 ? (
        <DialogValues values={userValues} />
      ) : (
        <div className="text-sm">
          <Markdown>{item.text}</Markdown>
        </div>
      )}
    </div>
  )
}

/** A live (persistent) dialog SUBMIT the user sent to the agent (sender="dialog-untrusted"). */
export function DialogSubmitChannel({ item }: { item: ChannelRenderItem }) {
  const userValues = valueEntries(item.text)
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 my-1 shadow-sm">
      <div className="flex items-center gap-2 mb-1.5">
        <Send className="size-3 text-primary/70" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-primary/70">live dialog</span>
        <span className="rounded border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-primary">
          {item.dialogStatus || 'sent'}
        </span>
      </div>
      {userValues.length > 0 ? (
        <DialogValues values={userValues} />
      ) : (
        <div className="text-sm">
          <Markdown>{item.text}</Markdown>
        </div>
      )}
    </div>
  )
}

/** Render a submitted form's values as a compact key/value list. */
function DialogValues({ values }: { values: Array<[string, unknown]> }) {
  return (
    <div className="text-[11px] font-mono space-y-1">
      {values.map(([key, val]) => (
        <div key={key} className="flex items-start gap-2">
          <span className="text-violet-400 font-bold shrink-0">{key}</span>
          <span className="text-foreground/80 break-all">
            {typeof val === 'boolean' ? (
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded text-[9px] font-bold border',
                  val
                    ? 'bg-green-500/15 text-green-400 border-green-500/30'
                    : 'bg-zinc-500/15 text-muted-foreground/50 border-zinc-500/20',
                )}
              >
                {String(val)}
              </span>
            ) : Array.isArray(val) ? (
              <span className="flex flex-wrap gap-1">
                {val.map((v, j) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: display-only array values, no stable IDs
                    // react-doctor-disable-next-line react-doctor/no-array-index-key
                    key={j}
                    className="px-1.5 py-0.5 bg-violet-500/15 text-violet-300 border border-violet-500/25 rounded text-[9px]"
                  >
                    {String(v)}
                  </span>
                ))}
              </span>
            ) : typeof val === 'string' && val.length > 0 ? (
              <span className="text-foreground/90">{val}</span>
            ) : val !== null && typeof val === 'object' ? (
              // Nested object value, e.g. a commentable diagram's per-node notes
              // (`{ nodeId: note }`). Render as a sub-list instead of [object Object].
              <span className="flex flex-col gap-0.5">
                {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
                  <span key={k} className="flex items-start gap-1.5">
                    <span className="text-violet-300/70 shrink-0">{k}:</span>
                    <span className="text-foreground/80 break-all">{String(v)}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground/50">{String(val)}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
