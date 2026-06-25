import { Markdown } from '../markdown'
import { DispatchActions } from './dispatch-actions-block'
import { useDispatchStore } from './dispatch-store'
import { modelLabel, ToolEvents } from './dispatch-tool-events'

/**
 * The in-flight tail under the persisted conversation: live gears while the
 * dispatcher thinks, the latest reply text, that decision's affordances (candidate
 * pick / expensive confirm / take-me-there), and which model just answered.
 *
 * The reply is rendered DIRECTLY from the latest decision so the answer appears the
 * instant the decision lands -- it does NOT wait on the streamed history. Once the
 * history broadcast catches up and the same assistant turn shows in DispatchTranscript,
 * we drop the duplicate here (replyAlreadyInHistory).
 */
// fallow-ignore-next-line complexity
export function DispatchTail() {
  const pending = useDispatchStore(s => s.pending)
  const lastError = useDispatchStore(s => s.lastError)
  const activeEvents = useDispatchStore(s => (s.activeTraceId ? s.toolEvents[s.activeTraceId] : undefined))
  const latest = useDispatchStore(s => s.decisions[0])
  const routeTo = useDispatchStore(s => s.routeTo)
  const confirmExpensive = useDispatchStore(s => s.confirmExpensive)
  // Last assistant turn already in the streamed history -- used to dedupe the reply.
  const lastHistoryReply = useDispatchStore(
    s => [...(s.history?.transcript ?? [])].reverse().find(t => t.role !== 'user')?.content,
  )
  const model = pending ? undefined : modelLabel(latest?.model)

  const reply = latest?.reply?.trim() || ''
  const replyAlreadyInHistory = !!reply && lastHistoryReply?.trim() === reply
  const showReply = !pending && !!reply && !replyAlreadyInHistory

  return (
    <>
      {showReply && (
        <div className="flex gap-2.5 px-6 pb-2">
          <span
            className="mt-1.5 inline-block h-2 w-2 flex-none rounded-full"
            style={{ background: 'var(--accent)' }}
          />
          <div className="min-w-0 flex-1 text-[14px] leading-relaxed text-foreground/90">
            <Markdown>{reply}</Markdown>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 px-6 pb-2">
        {pending && <ToolEvents events={activeEvents} />}
        {latest && <DispatchActions d={latest} routeTo={routeTo} confirmExpensive={confirmExpensive} />}
        {model && <span className="font-mono text-[10.5px] text-comment/45">via {model}</span>}
      </div>

      {pending && (
        <p className="px-6 pb-4 text-[13px] text-comment">
          <span
            className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full align-middle"
            style={{ background: 'var(--accent)' }}
          />
          one sec…
        </p>
      )}
      {lastError && (
        <p className="mx-6 mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2 text-[12.5px] text-destructive">
          {lastError}
        </p>
      )}
    </>
  )
}
