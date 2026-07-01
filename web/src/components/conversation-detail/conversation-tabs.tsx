import { Braces, Terminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { useConversationsStore } from '@/hooks/use-conversations'
import { isShareView } from '@/lib/share-mode'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

// react-doctor:only-export-components -- Tab type + tabVisibility are co-located
// with ConversationTabs and exported for unit tests; splitting hurts cohesion.
export type Tab = 'transcript' | 'tty' | 'json_stream' | 'events' | 'agents' | 'tasks' | 'shared' | 'project' | 'diag'

interface ConversationTabsProps {
  conversation: Conversation
  activeTab: Tab
  onSetActiveTab: (tab: Tab) => void
  hasTerminal: boolean
  hasJsonStream: boolean
  canAdmin: boolean
  canReadTerminal: boolean
  showDiag: boolean
  expandAll: boolean
}

interface TabButtonProps {
  active: boolean
  onClick: (event: React.MouseEvent) => void
  children: ReactNode
  title?: string
  /** Extra classes for the button (beyond the shared tab shape). */
  className?: string
}

function TabButton({ active, onClick, children, title, className }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
        active ? 'border-accent text-accent' : 'border-transparent text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Tap-to-switch handler factory with haptic feedback. Not a hook -- plain function. */
function tabClickHandler(target: Tab, onSetActiveTab: (tab: Tab) => void) {
  return () => {
    haptic('tick')
    onSetActiveTab(target)
  }
}

/** Which optional tabs are visible. Pure -- pulls all the gating predicates out
 *  of the component so the render stays flat. `shareView` (a share-link guest)
 *  hard-hides the host-internal JSON + Project tabs; the broker independently
 *  bars both channels for share grants. Exported for unit tests. */
export function tabVisibility(p: {
  conversation: Conversation
  hasTerminal: boolean
  hasJsonStream: boolean
  canAdmin: boolean
  canReadTerminal: boolean
  showDiag: boolean
  shareView: boolean
}) {
  const c = p.conversation
  const hasAgents = c.totalSubagentCount > 0 || c.activeSubagentCount > 0 || c.bgTasks.length > 0
  return {
    tty: p.hasTerminal && p.canReadTerminal,
    json: p.hasJsonStream && p.canReadTerminal && !p.shareView,
    events: p.canAdmin,
    agents: p.canAdmin && hasAgents,
    tasks: c.taskCount > 0 || (c.archivedTaskCount ?? 0) > 0,
    project: c.status !== 'ended' && !p.shareView,
    diag: p.canAdmin && p.showDiag,
    verbose: p.canAdmin,
  }
}

export function ConversationTabs({
  conversation,
  activeTab,
  onSetActiveTab,
  hasTerminal,
  hasJsonStream,
  canAdmin,
  canReadTerminal,
  showDiag,
  expandAll,
}: ConversationTabsProps) {
  const vis = tabVisibility({
    conversation,
    hasTerminal,
    hasJsonStream,
    canAdmin,
    canReadTerminal,
    showDiag,
    shareView: isShareView(),
  })
  return (
    <div className="shrink-0 flex items-center border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      <TabButton active={activeTab === 'transcript'} onClick={tabClickHandler('transcript', onSetActiveTab)}>
        Transcript
      </TabButton>

      {vis.tty && (
        <TabButton
          active={activeTab === 'tty'}
          className="flex items-center gap-1"
          title="Terminal (Shift+click to pop out)"
          onClick={e => {
            if (e.shiftKey) {
              const wid = conversation?.connectionIds?.[0]
              if (wid) window.open(`/#popout-terminal/${wid}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no')
            } else {
              haptic('tick')
              onSetActiveTab(activeTab === 'tty' ? 'transcript' : 'tty')
            }
          }}
        >
          <Terminal className="size-3" />
          TTY
        </TabButton>
      )}

      {vis.json && (
        <TabButton
          active={activeTab === 'json_stream'}
          className="flex items-center gap-1"
          onClick={() => {
            haptic('tick')
            onSetActiveTab(activeTab === 'json_stream' ? 'transcript' : 'json_stream')
          }}
        >
          <Braces className="size-3" />
          JSON
        </TabButton>
      )}

      {vis.events && (
        <TabButton active={activeTab === 'events'} onClick={tabClickHandler('events', onSetActiveTab)}>
          Events
        </TabButton>
      )}

      {vis.agents && (
        <TabButton active={activeTab === 'agents'} onClick={tabClickHandler('agents', onSetActiveTab)}>
          Agents
          {(conversation.activeSubagentCount > 0 || conversation.runningBgTaskCount > 0) && (
            <span className="ml-1.5 px-1.5 py-0.5 bg-active/20 text-active text-[10px] font-bold">
              {conversation.activeSubagentCount + conversation.runningBgTaskCount}
            </span>
          )}
        </TabButton>
      )}

      {vis.tasks && (
        <TabButton active={activeTab === 'tasks'} onClick={tabClickHandler('tasks', onSetActiveTab)}>
          Tasks
          {conversation.pendingTaskCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 text-[10px] font-bold">
              {conversation.pendingTaskCount}
            </span>
          )}
        </TabButton>
      )}

      {vis.project && (
        <TabButton active={activeTab === 'project'} onClick={tabClickHandler('project', onSetActiveTab)}>
          Project
        </TabButton>
      )}

      <TabButton active={activeTab === 'shared'} onClick={tabClickHandler('shared', onSetActiveTab)}>
        Shared
      </TabButton>

      {vis.diag && (
        <TabButton active={activeTab === 'diag'} onClick={tabClickHandler('diag', onSetActiveTab)}>
          Diag
        </TabButton>
      )}

      {/* Follow/verbose - pushed to right */}
      <div className="ml-auto pr-3 flex items-center gap-2">
        <div className="w-px h-4 bg-border" />
      </div>
      {vis.verbose && (
        <div className="pr-3 hidden sm:flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Checkbox
              id="verbose"
              checked={expandAll}
              onCheckedChange={checked => {
                if (checked !== expandAll) useConversationsStore.getState().toggleExpandAll()
              }}
              className="size-3.5"
            />
            <label htmlFor="verbose" className="text-[10px] text-muted-foreground cursor-pointer select-none">
              verbose
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
