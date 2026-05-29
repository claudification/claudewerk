import { useConversationsStore } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K tok`
  return `${tokens} tok`
}

// Terse model label for the roster badge: drop the `claude-` vendor prefix and
// any trailing date / context-window suffix so "claude-opus-4-8[1m]" reads as
// "opus-4-8". Short Agent-tool names ("opus") pass through unchanged.
export function shortModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\[.*\]$/, '')
}

// Self-subscribing live badge for an Agent tool row. Subscribes ONLY to its
// one matching subagent (by description) in the selected conversation -- so a
// subagent status/event/token update re-renders THIS badge alone, never the
// surrounding group or unrelated tool rows. The selector returns the matched
// subagent's existing store ref (or undefined) -- never a fresh object literal
// -- so Object.is comparison is correct (no React #185).
export function AgentTaskBadge({ description }: { description: string }) {
  const subagent = useConversationsStore(s => {
    const sid = s.selectedConversationId
    if (!sid) return undefined
    return s.conversationsById[sid]?.subagents?.find(a => a.description === description)
  })
  if (!subagent) return null
  const isRunning = subagent.status === 'running'
  const elapsed = subagent.stoppedAt
    ? Math.round((subagent.stoppedAt - subagent.startedAt) / 1000)
    : Math.round((Date.now() - subagent.startedAt) / 1000)
  const agentIdForNav = subagent.agentId
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        const store = useConversationsStore.getState()
        store.selectSubagent(agentIdForNav)
        if (store.selectedConversationId) {
          store.openTab(store.selectedConversationId, 'transcript')
        }
      }}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold cursor-pointer hover:brightness-125 transition-all',
        isRunning ? 'bg-active/20 text-active animate-pulse' : 'bg-emerald-500/20 text-emerald-400',
      )}
      title="View agent transcript"
    >
      {isRunning ? 'running' : 'done'}
      {subagent.model && (
        <span className="text-muted-foreground font-normal" title={`model: ${subagent.model}`}>
          {shortModel(subagent.model)}
        </span>
      )}
      {subagent.eventCount > 0 && (
        <span className="text-muted-foreground font-normal">{subagent.eventCount} events</span>
      )}
      <span className="text-muted-foreground font-normal">{elapsed}s</span>
      {subagent.tokenUsage && subagent.tokenUsage.totalOutput > 0 && (
        <span className="text-muted-foreground font-normal">
          {formatTokenCount(subagent.tokenUsage.totalOutput)} out
        </span>
      )}
    </button>
  )
}
