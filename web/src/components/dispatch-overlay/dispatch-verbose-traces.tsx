import type { DispatchDecision } from '@shared/protocol'
import { useDispatchStore } from './dispatch-store'
import { ToolEvents } from './dispatch-tool-events'

/** One dispatched turn's tool frames: the intent it answered + every tool the
 *  agent loop ran (the dimmed gears), with the loop's tool-call count. */
// fallow-ignore-next-line complexity -- a presentational && chain; score is coverage-inflated, not real risk
function Trace({ decision }: { decision: DispatchDecision }) {
  const events = useDispatchStore(s => s.toolEvents[decision.traceId])
  if (!events?.length && !decision.toolCallCount) return null
  return (
    <details className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <summary className="cursor-pointer truncate text-[11px] text-comment">
        {decision.intent || '(turn)'} · {decision.toolCallCount ?? events?.length ?? 0} tool calls
      </summary>
      <div className="mt-1.5">
        <ToolEvents events={events} />
      </div>
    </details>
  )
}

/**
 * The per-turn TOOL FRAMES of the live session (Slice D) -- what the dispatcher
 * actually DID, surfaced under the verbose view. Streamed tool frames are
 * session-live (not persisted), so this covers the turns dispatched since the
 * overlay connected; the persisted conversation itself is the transcript.
 */
export function DispatchTraces() {
  const decisions = useDispatchStore(s => s.decisions)
  const withTools = decisions.filter(d => d.toolCallCount)
  if (withTools.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[9.5px] uppercase tracking-wider text-comment/50">tool frames (this session)</span>
      {withTools.map(d => (
        <Trace key={d.decisionId} decision={d} />
      ))}
    </div>
  )
}
