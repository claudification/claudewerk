import type { HookEvent } from '@shared/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tree, type NodeRendererProps } from 'react-arborist'
import { saveSessionOrder, useSessionsStore } from '@/hooks/use-sessions'
import type { Session, SessionOrderGroup, SessionOrderNode, SessionOrderSession, SessionOrderV2 } from '@/lib/types'
import { cn, formatAge, formatModel, haptic, lastPathSegments } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from './project-settings-editor'

// ─── Shared visual components (unchanged) ──────────────────────────

function StatusIndicator({ status }: { status: Session['status'] }) {
  if (status === 'ended') {
    return <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-ended text-foreground">ended</span>
  }
  if (status === 'active') {
    return (
      <span className="w-3 h-3 shrink-0 flex items-center justify-center" title="working">
        <span
          className="w-2.5 h-2.5 rounded-full animate-spin"
          style={{ border: '2px solid var(--active)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  if (status === 'starting') {
    return (
      <span
        className="w-2 h-2 rounded-full shrink-0 animate-pulse"
        style={{ backgroundColor: 'var(--idle)' }}
        title="starting"
      />
    )
  }
  return <span className="w-2 h-2 rounded-full shrink-0 bg-idle" title={status} />
}

const EMPTY_EVENTS: HookEvent[] = []

function DismissButton({ sessionId }: { sessionId: string }) {
  const dismissSession = useSessionsStore(s => s.dismissSession)
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="flex items-center gap-1 text-[9px]" onClick={e => e.stopPropagation()}>
        <div
          onClick={() => {
            haptic('tap')
            dismissSession(sessionId)
            setConfirming(false)
          }}
          className="text-destructive hover:text-destructive/80 cursor-pointer font-bold"
        >
          yes
        </div>
        <div
          onClick={() => setConfirming(false)}
          className="text-muted-foreground hover:text-foreground cursor-pointer"
        >
          no
        </div>
      </div>
    )
  }

  return (
    <div
      onClick={e => {
        e.stopPropagation()
        haptic('tap')
        setConfirming(true)
      }}
      className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity cursor-pointer px-0.5"
      title="Dismiss session"
    >
      {'\u2715'}
    </div>
  )
}

function DismissAllEndedButton({ sessions }: { sessions: Session[] }) {
  const dismissSession = useSessionsStore(s => s.dismissSession)
  const ended = sessions.filter(s => s.status === 'ended')
  const [confirming, setConfirming] = useState(false)
  if (ended.length === 0) return null

  if (confirming) {
    return (
      <div className="flex items-center gap-1 text-[9px]" onClick={e => e.stopPropagation()}>
        <span className="text-muted-foreground">dismiss {ended.length}?</span>
        <div
          onClick={() => {
            haptic('tap')
            for (const s of ended) dismissSession(s.id)
            setConfirming(false)
          }}
          className="text-destructive hover:text-destructive/80 cursor-pointer font-bold"
        >
          yes
        </div>
        <div
          onClick={() => setConfirming(false)}
          className="text-muted-foreground hover:text-foreground cursor-pointer"
        >
          no
        </div>
      </div>
    )
  }

  return (
    <div
      onClick={e => {
        e.stopPropagation()
        haptic('tap')
        setConfirming(true)
      }}
      className="text-[9px] text-muted-foreground/40 hover:text-destructive cursor-pointer px-1 transition-colors"
      title={`Dismiss ${ended.length} ended session${ended.length > 1 ? 's' : ''}`}
    >
      {'\u2715'} ended
    </div>
  )
}

function SessionItemContent({ session, compact }: { session: Session; compact?: boolean }) {
  const selectedSessionId = useSessionsStore(s => s.selectedSessionId)
  const selectedSubagentId = useSessionsStore(s => s.selectedSubagentId)
  const selectSession = useSessionsStore(s => s.selectSession)
  const selectSubagent = useSessionsStore(s => s.selectSubagent)
  const openTab = useSessionsStore(s => s.openTab)
  const cachedEvents = useSessionsStore(s => s.events[session.id] || EMPTY_EVENTS)
  const ps = useSessionsStore(s => s.projectSettings[session.cwd])
  const isSelected = selectedSessionId === session.id
  const sessionStartEvent = cachedEvents.find(e => e.hookEvent === 'SessionStart')
  const model = (sessionStartEvent?.data as { model?: string } | undefined)?.model

  function handleClick() {
    haptic('tap')
    selectSession(session.id)
  }

  const displayName = ps?.label || lastPathSegments(session.cwd)
  const displayColor = ps?.color

  return (
    <div
      onClick={handleClick}
      className={cn(
        'w-full text-left border transition-colors group cursor-pointer',
        compact ? 'p-2 pl-4 text-[11px]' : 'p-3',
        isSelected
          ? 'border-accent bg-accent/15 ring-1 ring-accent/50 shadow-[0_0_8px_rgba(122,162,247,0.15)]'
          : displayColor
            ? 'border-border hover:border-primary'
            : 'border-border hover:border-primary hover:bg-card',
      )}
      style={
        displayColor && !isSelected
          ? { borderLeftColor: displayColor, borderLeftWidth: '3px', backgroundColor: `${displayColor}15` }
          : undefined
      }
      title={`${session.id}\n${formatModel(model || session.model)}`}
    >
      {!compact && (
        <div className="flex items-center gap-1.5">
          <StatusIndicator status={session.status} />
          {ps?.icon && (
            <span style={displayColor && !isSelected ? { color: displayColor } : undefined}>
              {renderProjectIcon(ps.icon)}
            </span>
          )}
          <span
            className={cn('font-bold text-sm flex-1 truncate', isSelected ? 'text-accent' : 'text-primary')}
            style={displayColor && !isSelected ? { color: displayColor } : undefined}
          >
            {displayName}
          </span>
          {session.compacting && (
            <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-400/20 text-amber-400 border border-amber-400/50 animate-pulse">
              compacting
            </span>
          )}
          {session.lastError && (
            <span
              className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-destructive/20 text-destructive border border-destructive/50"
              title={session.lastError.errorMessage || session.lastError.errorType || 'API error'}
            >
              error
            </span>
          )}
          {session.status === 'ended' && <DismissButton sessionId={session.id} />}
        </div>
      )}
      {compact && (
        <div className="flex items-center gap-1.5">
          <StatusIndicator status={session.status} />
          <span
            className={cn(
              'font-mono text-[11px] flex-1 truncate',
              isSelected ? 'text-accent' : 'text-muted-foreground',
            )}
          >
            {session.id.slice(0, 8)}
          </span>
          {session.compacting && <span className="text-[9px] text-amber-400 font-bold animate-pulse">COMPACT</span>}
          {session.lastError && <span className="text-[9px] text-destructive font-bold">ERROR</span>}
          {session.status === 'ended' && <DismissButton sessionId={session.id} />}
        </div>
      )}
      {(session.activeTasks.length > 0 ||
        session.pendingTasks.length > 0 ||
        session.subagents.length > 0 ||
        session.teammates.some(t => t.status === 'working')) && (
        <div className="mt-1 space-y-0.5">
          {session.activeTasks.slice(0, 5).map(task => (
            <div key={task.id} className="text-[11px] text-active/80 font-mono truncate pl-1">
              <span className="text-active mr-1">{'\u25B8'}</span>
              {task.subject}
            </div>
          ))}
          {session.pendingTasks.slice(0, Math.max(0, 5 - session.activeTasks.length)).map(task => (
            <div key={task.id} className="text-[11px] text-amber-400/50 font-mono truncate pl-1">
              <span className="text-amber-400/40 mr-1">{'\u25CB'}</span>
              {task.subject}
            </div>
          ))}
          {session.activeTasks.length + session.pendingTasks.length > 5 && (
            <div className="text-[10px] text-muted-foreground pl-1 font-mono">
              ..{session.activeTasks.length + session.pendingTasks.length - 5} more
            </div>
          )}
          {session.subagents
            .filter(a => a.status === 'running')
            .map(a => (
              <div
                key={a.agentId}
                className={cn(
                  'text-[11px] text-pink-400/80 font-mono truncate pl-1 cursor-pointer hover:text-pink-300',
                  selectedSubagentId === a.agentId && 'text-pink-300 font-bold',
                )}
                onClick={e => {
                  e.stopPropagation()
                  selectSession(session.id)
                  selectSubagent(a.agentId)
                }}
              >
                <span className="text-pink-400 mr-1">{'\u25CF'}</span>
                {a.description || a.agentType} <span className="text-pink-400/50">{a.agentId.slice(0, 6)}</span>
              </div>
            ))}
          {session.subagents
            .filter(a => a.status === 'stopped' && a.stoppedAt && Date.now() - a.stoppedAt < 30 * 60 * 1000)
            .map(a => (
              <div
                key={a.agentId}
                className={cn(
                  'text-[11px] text-pink-400/40 font-mono truncate pl-1 cursor-pointer hover:text-pink-400/70',
                  selectedSubagentId === a.agentId && 'text-pink-400/80 font-bold',
                )}
                onClick={e => {
                  e.stopPropagation()
                  selectSession(session.id)
                  selectSubagent(a.agentId)
                }}
              >
                <span className="mr-1">{'\u25CB'}</span>
                {a.description || a.agentType} <span className="text-pink-400/30">{a.agentId.slice(0, 6)}</span>
              </div>
            ))}
          {session.teammates
            .filter(t => t.status === 'working')
            .map(t => (
              <div key={t.name} className="text-[11px] text-purple-400/80 font-mono truncate pl-1">
                <span className="text-purple-400 mr-1">{'\u2691'}</span>
                {t.name}
                {t.currentTaskSubject ? `: ${t.currentTaskSubject}` : ''}
              </div>
            ))}
        </div>
      )}
      {!compact && (session.runningBgTaskCount > 0 || session.team) && (
        <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
          {session.runningBgTaskCount > 0 && (
            <span
              className="px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 text-[10px] font-bold cursor-pointer hover:bg-emerald-400/30"
              onClick={e => {
                e.stopPropagation()
                openTab(session.id, 'agents')
              }}
            >
              [{session.runningBgTaskCount}] bg
            </span>
          )}
          {session.team && (
            <span className="px-1.5 py-0.5 bg-purple-400/20 text-purple-400 border border-purple-400/50 text-[10px] font-bold uppercase">
              {session.team.role === 'lead' ? 'LEAD' : 'TEAM'} {session.team.teamName}
              {session.teammates.length > 0 &&
                ` (${session.teammates.filter(t => t.status !== 'stopped').length}/${session.teammates.length})`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function InactiveProjectItem({ sessions }: { sessions: Session[] }) {
  const selectSession = useSessionsStore(s => s.selectSession)
  const projectSettings = useSessionsStore(s => s.projectSettings)
  const latest = sessions.reduce((a, b) => (a.lastActivity > b.lastActivity ? a : b))
  const ps = projectSettings[latest.cwd]
  const displayName = ps?.label || lastPathSegments(latest.cwd)
  const displayColor = ps?.color

  function handleClick() {
    haptic('tap')
    selectSession(latest.id)
  }

  return (
    <div
      onClick={handleClick}
      className="w-full text-left border border-border hover:border-primary p-2 pl-3 transition-colors cursor-pointer"
      style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
      title={`${sessions.length} session${sessions.length > 1 ? 's' : ''}\n${latest.cwd}`}
    >
      <div className="flex items-center gap-1.5">
        {ps?.icon && (
          <span className="text-muted-foreground" style={displayColor ? { color: displayColor } : undefined}>
            {renderProjectIcon(ps.icon)}
          </span>
        )}
        <span
          className="font-mono text-xs text-muted-foreground truncate flex-1"
          style={displayColor ? { color: `${displayColor}99` } : undefined}
        >
          {displayName}
        </span>
        <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">
          {formatAge(latest.lastActivity)}
        </span>
      </div>
    </div>
  )
}

// ─── Tree data model ───────────────────────────────────────────────

interface TreeNodeData {
  id: string
  name: string
  type: 'group' | 'session' | 'cwd'
  cwd?: string
  sessions?: Session[]
  children?: TreeNodeData[]
}

function buildTreeData(
  sessionOrder: SessionOrderV2,
  sessions: Session[],
  showInactive: boolean,
): TreeNodeData[] {
  // Group all sessions by CWD
  const sessionsByCwd = new Map<string, Session[]>()
  for (const s of sessions) {
    const group = sessionsByCwd.get(s.cwd) || []
    group.push(s)
    sessionsByCwd.set(s.cwd, group)
  }

  // Track which CWDs are in the tree
  const treeCwds = new Set<string>()

  function buildNode(node: SessionOrderNode): TreeNodeData | null {
    if (node.type === 'group') {
      const children = node.children.map(buildNode).filter(Boolean) as TreeNodeData[]
      return {
        id: node.id,
        name: node.name,
        type: 'group',
        children,
      }
    }
    // Session node - extract CWD
    const cwd = node.id.startsWith('cwd:') ? node.id.slice(4) : node.id
    treeCwds.add(cwd)
    const cwdSessions = sessionsByCwd.get(cwd)
    if (!cwdSessions) return null // No live sessions for this CWD
    return {
      id: node.id,
      name: lastPathSegments(cwd),
      type: 'cwd',
      cwd,
      sessions: cwdSessions,
    }
  }

  // Build organized tree
  const organized = sessionOrder.tree.map(buildNode).filter(Boolean) as TreeNodeData[]

  // Unorganized: active sessions not in tree
  const unorganized: TreeNodeData[] = []
  const activeCwds = new Set<string>()
  for (const s of sessions) {
    if (s.status !== 'ended' && !treeCwds.has(s.cwd) && !activeCwds.has(s.cwd)) {
      activeCwds.add(s.cwd)
      const cwdSessions = sessionsByCwd.get(s.cwd) || [s]
      unorganized.push({
        id: `cwd:${s.cwd}`,
        name: lastPathSegments(s.cwd),
        type: 'cwd',
        cwd: s.cwd,
        sessions: cwdSessions.filter(x => x.status !== 'ended'),
      })
    }
  }
  // Sort unorganized by most recent
  unorganized.sort((a, b) => {
    const aMax = Math.max(...(a.sessions?.map(s => s.startedAt) || [0]))
    const bMax = Math.max(...(b.sessions?.map(s => s.startedAt) || [0]))
    return bMax - aMax
  })

  // Combine: organized tree + unorganized flat
  const result = [...organized, ...unorganized]

  // Inactive: ended sessions not in tree and not in unorganized
  if (showInactive) {
    const coveredCwds = new Set([...treeCwds, ...activeCwds])
    const inactiveByCwd = new Map<string, Session[]>()
    for (const s of sessions) {
      if (s.status === 'ended' && !coveredCwds.has(s.cwd)) {
        const group = inactiveByCwd.get(s.cwd) || []
        group.push(s)
        inactiveByCwd.set(s.cwd, group)
      }
    }
    if (inactiveByCwd.size > 0) {
      result.push({
        id: '__inactive__',
        name: `Inactive (${inactiveByCwd.size})`,
        type: 'group',
        children: Array.from(inactiveByCwd.entries())
          .sort((a, b) => {
            const aMax = Math.max(...a[1].map(s => s.lastActivity))
            const bMax = Math.max(...b[1].map(s => s.lastActivity))
            return bMax - aMax
          })
          .map(([cwd, cwdSessions]) => ({
            id: `inactive:${cwd}`,
            name: lastPathSegments(cwd),
            type: 'cwd' as const,
            cwd,
            sessions: cwdSessions,
          })),
      })
    }
  }

  return result
}

// Convert tree data back to SessionOrderV2 (for persistence after DnD)
function treeDataToOrder(nodes: TreeNodeData[]): SessionOrderV2 {
  function toNode(data: TreeNodeData): SessionOrderNode | null {
    if (data.id === '__inactive__') return null // Don't persist inactive group
    if (data.id.startsWith('inactive:')) return null
    if (data.type === 'group') {
      return {
        id: data.id,
        type: 'group',
        name: data.name,
        children: (data.children || []).map(toNode).filter(Boolean) as SessionOrderNode[],
      } satisfies SessionOrderGroup
    }
    return { id: data.id, type: 'session' } satisfies SessionOrderSession
  }
  return {
    version: 2,
    tree: nodes.map(toNode).filter(Boolean) as SessionOrderNode[],
  }
}

// ─── Tree node renderer ────────────────────────────────────────────

function TreeNode({ node, style, dragHandle }: NodeRendererProps<TreeNodeData>) {
  const data = node.data
  const [showSettings, setShowSettings] = useState(false)
  const projectSettings = useSessionsStore(s => (data.cwd ? s.projectSettings[data.cwd] : undefined))

  // Group node
  if (data.type === 'group') {
    const isInactive = data.id === '__inactive__'
    return (
      <div style={style}>
        <div
          ref={dragHandle}
          className={cn(
            'text-[10px] font-bold uppercase tracking-wider px-1 py-1 flex items-center gap-1.5 cursor-pointer select-none',
            isInactive ? 'text-muted-foreground/50' : 'text-primary/60',
          )}
          onClick={() => node.toggle()}
        >
          <span>{node.isOpen ? '\u25BE' : '\u25B8'}</span>
          {node.isEditing ? (
            <input
              type="text"
              defaultValue={data.name}
              autoFocus
              className="bg-transparent border-b border-primary text-primary text-[10px] font-bold uppercase outline-none w-full"
              onBlur={e => node.submit(e.currentTarget.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') node.submit(e.currentTarget.value)
                if (e.key === 'Escape') node.reset()
              }}
            />
          ) : (
            <>
              <span onDoubleClick={() => !isInactive && node.edit()}>{data.name}</span>
              {!node.isOpen && (
                <span className="text-muted-foreground/40 font-normal normal-case">
                  ({data.children?.length || 0})
                </span>
              )}
            </>
          )}
          <span className="flex-1 h-px bg-border/50" />
        </div>
      </div>
    )
  }

  // CWD/Session node
  const cwdSessions = data.sessions || []
  const ps = projectSettings

  if (cwdSessions.length === 0) return <div style={style} />

  if (cwdSessions.length === 1) {
    // Single session
    return (
      <div style={style} ref={dragHandle}>
        <div className="relative">
          <SessionItemContent session={cwdSessions[0]} />
          <div className="absolute top-2 right-2">
            <ProjectSettingsButton
              onClick={e => {
                e.stopPropagation()
                setShowSettings(!showSettings)
              }}
            />
          </div>
        </div>
        {showSettings && data.cwd && (
          <ProjectSettingsEditor cwd={data.cwd} onClose={() => setShowSettings(false)} />
        )}
      </div>
    )
  }

  // Multi-session CWD group
  const displayName = ps?.label || data.name
  const displayColor = ps?.color

  return (
    <div style={style} ref={dragHandle}>
      <div
        className="border border-border"
        style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
      >
        <div className="flex items-center gap-1.5 p-3 pb-1">
          {ps?.icon && (
            <span style={displayColor ? { color: displayColor } : undefined}>{renderProjectIcon(ps.icon)}</span>
          )}
          <span
            className="font-bold text-sm flex-1 truncate text-primary"
            style={displayColor ? { color: displayColor } : undefined}
          >
            {displayName}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">{cwdSessions.length} sessions</span>
          {cwdSessions.some(s => s.status === 'ended') && <DismissAllEndedButton sessions={cwdSessions} />}
          <ProjectSettingsButton
            onClick={e => {
              e.stopPropagation()
              setShowSettings(!showSettings)
            }}
          />
        </div>
        <div className="space-y-0.5 pb-1">
          {cwdSessions.map(session => (
            <SessionItemContent key={session.id} session={session} compact />
          ))}
        </div>
      </div>
      {showSettings && data.cwd && (
        <ProjectSettingsEditor cwd={data.cwd} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

// ─── Main SessionList component ────────────────────────────────────

export function SessionList() {
  const sessions = useSessionsStore(s => s.sessions)
  const sessionOrder = useSessionsStore(s => s.sessionOrder)
  const dashPrefs = useSessionsStore(s => s.dashboardPrefs)
  const [showInactive, setShowInactive] = useState(dashPrefs.showInactiveByDefault)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerHeight, setContainerHeight] = useState(600)

  // Refresh timestamps periodically
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Track container height for react-arborist
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height
      if (h) setContainerHeight(h)
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // Build tree data from session order + live sessions
  const treeData = useMemo(
    () => buildTreeData(sessionOrder, sessions, showInactive),
    [sessionOrder, sessions, showInactive],
  )

  // Inactive session count (for toggle)
  const inactiveCount = useMemo(() => {
    const treeCwds = new Set<string>()
    function walk(nodes: SessionOrderNode[]) {
      for (const n of nodes) {
        if (n.type === 'session') {
          const cwd = n.id.startsWith('cwd:') ? n.id.slice(4) : n.id
          treeCwds.add(cwd)
        } else if (n.type === 'group') walk(n.children)
      }
    }
    walk(sessionOrder.tree)
    const activeCwds = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.cwd))
    return new Set(
      sessions.filter(s => s.status === 'ended' && !treeCwds.has(s.cwd) && !activeCwds.has(s.cwd)).map(s => s.cwd),
    ).size
  }, [sessionOrder, sessions])

  // Persist tree order after any DnD operation
  const handleMoveFinished = useCallback(
    (_args: { dragIds: string[]; parentId: string | null; index: number; dragNodes: any[]; parentNode: any }) => {
      // After react-arborist applies the move, read the new tree structure and persist
      // We defer this to let the tree component update first
      setTimeout(() => {
        const treeApi = treeRef.current
        if (!treeApi) return
        // Walk the tree API to extract the current structure
        const root = treeApi.root
        function extractNodes(node: any): TreeNodeData[] {
          if (!node.children) return []
          return node.children.map((child: any) => {
            const data = child.data as TreeNodeData
            if (data.type === 'group') {
              return { ...data, children: extractNodes(child) }
            }
            return data
          })
        }
        const newTree = extractNodes(root)
        const newOrder = treeDataToOrder(newTree)
        useSessionsStore.getState().setSessionOrder(newOrder)
        saveSessionOrder(newOrder)
      }, 0)
    },
    [],
  )

  const treeRef = useRef<any>(null)

  // Handle rename
  const handleRename = useCallback(
    ({ id, name }: { id: string; name: string }) => {
      if (!name.trim()) return
      // Update the group name in the order
      function renameInTree(nodes: SessionOrderNode[]): SessionOrderNode[] {
        return nodes.map(n => {
          if (n.type === 'group' && n.id === id) {
            return { ...n, name: name.trim() }
          }
          if (n.type === 'group') {
            return { ...n, children: renameInTree(n.children) }
          }
          return n
        })
      }
      const newOrder: SessionOrderV2 = { version: 2, tree: renameInTree(sessionOrder.tree) }
      useSessionsStore.getState().setSessionOrder(newOrder)
      saveSessionOrder(newOrder)
    },
    [sessionOrder],
  )

  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10">
        <pre className="text-xs mb-4">
          {`
  No sessions yet

  Start a session with:
  $ rclaude
`.trim()}
        </pre>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="flex-1 min-h-0">
        <Tree<TreeNodeData>
          ref={treeRef}
          data={treeData}
          width="100%"
          height={containerHeight}
          rowHeight={64}
          indent={16}
          padding={8}
          onMove={handleMoveFinished}
          onRename={handleRename}
          disableDrop={({ parentNode }) => {
            // Only allow dropping into groups or root, not into session/cwd nodes
            if (!parentNode) return false // root drop OK
            return parentNode.data.type !== 'group'
          }}
          openByDefault={true}
        >
          {TreeNode}
        </Tree>
      </div>

      {/* Inactive toggle */}
      {inactiveCount > 0 && (
        <label className="shrink-0 flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs cursor-pointer select-none border-t border-border">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
            className="accent-primary"
          />
          show inactive ({inactiveCount})
        </label>
      )}
    </div>
  )
}
