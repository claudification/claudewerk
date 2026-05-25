import { extractProjectLabel } from '@shared/project-uri'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import type { Conversation, ProjectSettings } from '@/lib/types'
import { cn, formatAge } from '@/lib/utils'
import { renderProjectIcon } from '../project-settings-editor'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { ALL_BATCH_ACTIONS, type BatchAction } from './batch-actions'
import { BatchProgress } from './batch-progress'

const SELECT_ALL_CAP = 50

function buildClearableField(key: 'toHostSentinelId' | 'toProfile', value: string): Record<string, string | null> {
  if (value === '__clear__') return { [key]: null }
  if (value) return { [key]: value }
  return {}
}

interface FilterState {
  project: string
  status: 'any' | 'live' | 'idle'
  sentinel: string
  text: string
  showEnded: boolean
}

function matchesStatus(c: Conversation, filter: FilterState): boolean {
  if (!filter.showEnded && c.status === 'ended') return false
  if (filter.status === 'any') return true
  if (filter.status === 'live') return c.status === 'active'
  return c.status === 'idle'
}

function matchesSentinel(c: Conversation, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    (c.hostSentinelId ?? '').toLowerCase().includes(needle) ||
    (c.hostSentinelAlias ?? '').toLowerCase().includes(needle)
  )
}

function matchesText(c: Conversation, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (c.title ?? '').toLowerCase().includes(needle) || c.project.toLowerCase().includes(needle)
}

function matchesProject(c: Conversation, q: string): boolean {
  if (!q) return true
  return c.project.toLowerCase().includes(q.toLowerCase())
}

function filterConversations(conversations: Conversation[], filter: FilterState): Conversation[] {
  return conversations.filter(
    c =>
      matchesProject(c, filter.project) &&
      matchesStatus(c, filter) &&
      matchesSentinel(c, filter.sentinel) &&
      matchesText(c, filter.text),
  )
}

function projectLabelFor(c: Conversation, settings: Record<string, ProjectSettings>): string {
  return settings[c.project]?.label || extractProjectLabel(c.project)
}

/** Project asc, then lastActivity desc (newest first within a project). */
function defaultSort(a: Conversation, b: Conversation, settings: Record<string, ProjectSettings>): number {
  const ap = projectLabelFor(a, settings).toLowerCase()
  const bp = projectLabelFor(b, settings).toLowerCase()
  if (ap !== bp) return ap < bp ? -1 : 1
  return (b.lastActivity ?? 0) - (a.lastActivity ?? 0)
}

interface GroupRow {
  kind: 'group'
  project: string
  label: string
  count: number
  color?: string
  icon?: string
}
interface ConvRow {
  kind: 'conv'
  conv: Conversation
  project: string
}
type FlatRow = GroupRow | ConvRow

function flatten(rows: Conversation[], groupBy: boolean, settings: Record<string, ProjectSettings>): FlatRow[] {
  if (!groupBy) return rows.map(c => ({ kind: 'conv' as const, conv: c, project: c.project }))
  const out: FlatRow[] = []
  let lastProject: string | null = null
  let runStart = 0
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i]
    if (!c) continue
    if (c.project !== lastProject) {
      // close previous header (write count once)
      if (lastProject !== null) {
        const header = out[runStart] as GroupRow
        header.count = i - runStart - (out.length - rows.slice(0, i).length)
      }
      const ps = settings[c.project]
      out.push({
        kind: 'group',
        project: c.project,
        label: ps?.label || extractProjectLabel(c.project),
        count: 0, // patched on next boundary / at end
        color: ps?.color,
        icon: ps?.icon,
      })
      runStart = out.length - 1
      lastProject = c.project
    }
    out.push({ kind: 'conv', conv: c, project: c.project })
  }
  // patch the final header's count
  let lastHeader: GroupRow | null = null
  let runCount = 0
  for (const r of out) {
    if (r.kind === 'group') {
      if (lastHeader) lastHeader.count = runCount
      lastHeader = r
      runCount = 0
    } else {
      runCount++
    }
  }
  if (lastHeader) lastHeader.count = runCount
  return out
}

function StatusDot({ status }: { status: Conversation['status'] }) {
  if (status === 'active') {
    return (
      <span className="w-2 h-2 inline-block shrink-0" title="active">
        <span
          className="block w-2 h-2 rounded-full animate-spin"
          style={{ border: '1.5px solid var(--active)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  if (status === 'ended') return <span className="text-[9px] uppercase font-bold text-muted-foreground/60">end</span>
  if (status === 'starting' || status === 'booting')
    return <span className="w-2 h-2 rounded-full shrink-0 animate-pulse" style={{ backgroundColor: 'var(--idle)' }} />
  return <span className="w-2 h-2 rounded-full shrink-0 bg-idle" title={status} />
}

function MutedDefault({ value }: { value: string | undefined | null }) {
  if (!value || value === 'default') return <span className="text-muted-foreground/40">—</span>
  return <span>{value}</span>
}

interface BatchModeModalProps {
  open: boolean
  onClose: () => void
}

export function BatchModeModal({ open, onClose }: BatchModeModalProps) {
  const { conversations, projectSettings, selectedForBatch, currentBatchId, sentinels, isAdmin } =
    useConversationsStore(
      useShallow(s => ({
        conversations: s.conversations,
        projectSettings: s.projectSettings,
        selectedForBatch: s.selectedForBatch,
        currentBatchId: s.currentBatchId,
        sentinels: s.sentinels,
        isAdmin: s.permissions.canAdmin,
      })),
    )
  const { selectBatch, clearBatchSelection, startBatch, toggleBatchSelection } = useConversationsStore(
    useShallow(s => ({
      selectBatch: s.selectBatch,
      clearBatchSelection: s.clearBatchSelection,
      startBatch: s.startBatch,
      toggleBatchSelection: s.toggleBatchSelection,
    })),
  )

  const [filterProject, setFilterProject] = useState('')
  const [filterStatus, setFilterStatus] = useState<FilterState['status']>('any')
  const [filterSentinel, setFilterSentinel] = useState('')
  const [filterText, setFilterText] = useState('')
  const [showEnded, setShowEnded] = useState(false)
  const [groupByProject, setGroupByProject] = useState(true)
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [selectedActionId, setSelectedActionId] = useState<string>(ALL_BATCH_ACTIONS[0]?.id ?? 'broadcast')
  const [confirmText, setConfirmText] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(0)
  const lastClickedIndexRef = useRef<number | null>(null)

  const [runningBatch, setRunningBatch] = useState<{
    batchId: string
    action: BatchAction
    ids: string[]
    input: unknown
  } | null>(null)
  const [broadcastMessage, setBroadcastMessage] = useState('')
  const [reassignProject, setReassignProject] = useState('')
  const [reassignSentinel, setReassignSentinel] = useState('')
  const [reassignProfile, setReassignProfile] = useState('')

  useEffect(() => {
    if (open && !currentBatchId) startBatch()
  }, [open, currentBatchId, startBatch])

  const action = ALL_BATCH_ACTIONS.find(a => a.id === selectedActionId) ?? ALL_BATCH_ACTIONS[0]

  const filtered = useMemo(() => {
    const base = filterConversations(conversations, {
      project: filterProject,
      status: filterStatus,
      sentinel: filterSentinel,
      text: filterText,
      showEnded,
    })
    const after = selectedOnly ? base.filter(c => selectedForBatch.has(c.id)) : base
    return [...after].sort((a, b) => defaultSort(a, b, projectSettings))
  }, [
    conversations,
    filterProject,
    filterStatus,
    filterSentinel,
    filterText,
    showEnded,
    selectedOnly,
    selectedForBatch,
    projectSettings,
  ])

  const flatRows = useMemo(
    () => flatten(filtered, groupByProject, projectSettings),
    [filtered, groupByProject, projectSettings],
  )
  const convRows = useMemo(() => flatRows.filter((r): r is ConvRow => r.kind === 'conv'), [flatRows])
  const focusableIndices = useMemo(
    () => flatRows.map((r, i) => (r.kind === 'conv' ? i : -1)).filter(i => i >= 0),
    [flatRows],
  )

  // Clamp focus when list size changes.
  useEffect(() => {
    if (focusedIndex >= flatRows.length) setFocusedIndex(Math.max(0, flatRows.length - 1))
  }, [flatRows.length, focusedIndex])

  const selectedIds = useMemo(() => Array.from(selectedForBatch), [selectedForBatch])

  const handleToggleAt = useCallback(
    (idx: number, shift: boolean) => {
      const row = flatRows[idx]
      if (!row || row.kind !== 'conv') return
      if (shift && lastClickedIndexRef.current !== null) {
        const a = Math.min(lastClickedIndexRef.current, idx)
        const b = Math.max(lastClickedIndexRef.current, idx)
        const range = flatRows.slice(a, b + 1).filter((r): r is ConvRow => r.kind === 'conv')
        const anyUnselected = range.some(r => !selectedForBatch.has(r.conv.id))
        const next = new Set(selectedForBatch)
        for (const r of range) {
          if (anyUnselected) next.add(r.conv.id)
          else next.delete(r.conv.id)
        }
        selectBatch(Array.from(next))
      } else {
        toggleBatchSelection(row.conv.id)
      }
      lastClickedIndexRef.current = idx
    },
    [flatRows, selectedForBatch, selectBatch, toggleBatchSelection],
  )

  function handleSelectAllVisible() {
    const visibleIds = convRows.slice(0, SELECT_ALL_CAP).map(r => r.conv.id)
    const next = new Set(selectedForBatch)
    for (const id of visibleIds) next.add(id)
    selectBatch(Array.from(next))
  }

  function handleSelectAllUnchecked() {
    if (convRows.length > SELECT_ALL_CAP && confirmText.trim() !== `select ${convRows.length}`) return
    selectBatch(convRows.map(r => r.conv.id))
  }

  function handleInvert() {
    const next = new Set<string>()
    for (const r of convRows) {
      if (!selectedForBatch.has(r.conv.id)) next.add(r.conv.id)
    }
    // Preserve any selections that are no longer visible (filtered out).
    for (const id of selectedForBatch) {
      if (!convRows.some(r => r.conv.id === id)) next.add(id)
    }
    selectBatch(Array.from(next))
  }

  function buildReassignInput() {
    return {
      ...(reassignProject ? { toProjectUri: reassignProject } : {}),
      ...buildClearableField('toHostSentinelId', reassignSentinel),
      ...buildClearableField('toProfile', reassignProfile),
    }
  }

  function handleRun() {
    const batchId = currentBatchId ?? startBatch()
    const input =
      action.requiresInput === 'broadcast'
        ? { message: broadcastMessage }
        : action.requiresInput === 'reassign'
          ? buildReassignInput()
          : undefined
    setRunningBatch({ batchId, action, ids: selectedIds, input })
  }

  function handleRetry(failedIds: string[]) {
    if (!runningBatch) return
    setRunningBatch({ ...runningBatch, ids: failedIds })
  }

  function handleClose() {
    setRunningBatch(null)
    onClose()
  }

  // ── Keyboard layer (modal-local; popped on unmount) ────────────────────
  const moveFocus = useCallback(
    (delta: number) => {
      if (focusableIndices.length === 0) return
      const cur = focusableIndices.findIndex(i => i === focusedIndex)
      const nextOrdinal = cur === -1 ? 0 : Math.max(0, Math.min(focusableIndices.length - 1, cur + delta))
      const target = focusableIndices[nextOrdinal] ?? 0
      setFocusedIndex(target)
    },
    [focusableIndices, focusedIndex],
  )

  useKeyLayer(
    {
      ArrowDown: e => {
        e.preventDefault()
        moveFocus(1)
      },
      ArrowUp: e => {
        e.preventDefault()
        moveFocus(-1)
      },
      ' ': e => {
        // ignore space when typing in an input/textarea
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        handleToggleAt(focusedIndex, e.shiftKey)
      },
      a: e => {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        handleSelectAllVisible()
      },
      i: e => {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        handleInvert()
      },
    },
    { id: 'batch-palette', enabled: open && !runningBatch },
  )

  if (!isAdmin) return null

  const visibleSelected = convRows.filter(r => selectedForBatch.has(r.conv.id))
  const canRun = selectedIds.length > 0 && !runningBatch
  const inputValid =
    action.requiresInput === 'broadcast'
      ? broadcastMessage.trim().length > 0
      : action.requiresInput === 'reassign'
        ? Boolean(reassignProject || reassignSentinel || reassignProfile)
        : true
  const confirmRequired = action.needsConfirm && selectedIds.length > 5
  const confirmOk = !confirmRequired || confirmText.trim() === `confirm ${selectedIds.length}`

  return (
    <Dialog open={open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col p-0 top-[10vh] translate-y-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-3">
            <DialogTitle className="text-sm font-bold text-accent">Batch operations</DialogTitle>
            {currentBatchId && <span className="text-[10px] text-muted-foreground font-mono">{currentBatchId}</span>}
            <span className="text-[10px] text-muted-foreground/70">[{selectedIds.length} selected]</span>
          </div>
        </div>

        {runningBatch ? (
          <BatchProgress
            action={runningBatch.action}
            conversationIds={runningBatch.ids}
            batchId={runningBatch.batchId}
            input={runningBatch.input}
            onRetry={handleRetry}
            onClose={handleClose}
          />
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2 px-3 py-2 border-b border-border text-xs">
              <input
                placeholder="project filter"
                value={filterProject}
                onChange={e => setFilterProject(e.target.value)}
                className="bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent"
              />
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value as FilterState['status'])}
                className="bg-muted/20 px-2 py-1 border border-border/40 outline-none"
              >
                <option value="any">any status</option>
                <option value="live">live</option>
                <option value="idle">idle</option>
              </select>
              <input
                placeholder="sentinel filter"
                value={filterSentinel}
                onChange={e => setFilterSentinel(e.target.value)}
                className="bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent"
              />
              <input
                placeholder="text search"
                value={filterText}
                onChange={e => setFilterText(e.target.value)}
                className="bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent"
              />
            </div>

            <div className="flex items-center justify-between px-3 py-1 border-b border-border/40 text-[10px] text-muted-foreground gap-2">
              <div className="flex items-center gap-3">
                <span>
                  {convRows.length} matches{visibleSelected.length > 0 && ` · ${visibleSelected.length} sel`}
                </span>
                <label className="flex items-center gap-1 cursor-pointer hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={groupByProject}
                    onChange={e => setGroupByProject(e.target.checked)}
                    className="cursor-pointer accent-accent"
                  />
                  group by project
                </label>
                <label className="flex items-center gap-1 cursor-pointer hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={showEnded}
                    onChange={e => setShowEnded(e.target.checked)}
                    className="cursor-pointer accent-accent"
                  />
                  show ended
                </label>
                {selectedIds.length > 0 && (
                  <label className="flex items-center gap-1 cursor-pointer hover:text-foreground">
                    <input
                      type="checkbox"
                      checked={selectedOnly}
                      onChange={e => setSelectedOnly(e.target.checked)}
                      className="cursor-pointer accent-accent"
                    />
                    selected only
                  </label>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSelectAllVisible}
                  className="px-2 py-0.5 bg-muted/30 hover:bg-muted/50 transition-colors"
                  title="Hotkey: a"
                >
                  Select visible (cap {SELECT_ALL_CAP})
                </button>
                <button
                  type="button"
                  onClick={handleInvert}
                  className="px-2 py-0.5 bg-muted/30 hover:bg-muted/50 transition-colors"
                  title="Hotkey: i"
                >
                  Invert
                </button>
                {convRows.length > SELECT_ALL_CAP && (
                  <>
                    <input
                      placeholder={`type "select ${convRows.length}"`}
                      value={confirmText}
                      onChange={e => setConfirmText(e.target.value)}
                      className="bg-muted/20 px-2 py-0.5 border border-border/40 outline-none w-40 text-[10px]"
                    />
                    <button
                      type="button"
                      disabled={confirmText.trim() !== `select ${convRows.length}`}
                      onClick={handleSelectAllUnchecked}
                      className="px-2 py-0.5 bg-amber-500/20 text-amber-400 disabled:opacity-40 hover:bg-amber-500/30"
                    >
                      Apply to all {convRows.length}
                    </button>
                  </>
                )}
                <button type="button" onClick={() => clearBatchSelection()} className="px-2 py-0.5 hover:bg-muted/30">
                  Clear
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-surface-inset border-b border-border/40 text-[10px] text-muted-foreground uppercase z-10">
                  <tr>
                    <th className="w-8 text-left px-2 py-1"> </th>
                    <th className="text-left px-2 py-1">title</th>
                    {!groupByProject && <th className="text-left px-2 py-1">project</th>}
                    <th className="text-left px-2 py-1">sentinel</th>
                    <th className="text-left px-2 py-1">profile</th>
                    <th className="text-left px-2 py-1">last</th>
                  </tr>
                </thead>
                <tbody>
                  {flatRows.map((row, idx) =>
                    row.kind === 'group' ? (
                      <BatchGroupHeader key={`g:${row.project}`} row={row} cols={groupByProject ? 5 : 6} />
                    ) : (
                      <BatchRow
                        key={row.conv.id}
                        row={row}
                        idx={idx}
                        checked={selectedForBatch.has(row.conv.id)}
                        focused={idx === focusedIndex}
                        groupByProject={groupByProject}
                        projectSettings={projectSettings}
                        onActivate={(i, shift) => handleToggleAt(i, shift)}
                        onFocus={() => setFocusedIndex(idx)}
                      />
                    ),
                  )}
                  {convRows.length === 0 && (
                    <tr>
                      <td colSpan={groupByProject ? 5 : 6} className="px-3 py-6 text-center text-muted-foreground">
                        No conversations match
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="border-t border-border px-3 py-2 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Action:</span>
                <select
                  value={selectedActionId}
                  onChange={e => {
                    setSelectedActionId(e.target.value)
                    setConfirmText('')
                  }}
                  className="bg-muted/20 px-2 py-1 border border-border/40"
                >
                  {ALL_BATCH_ACTIONS.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <span className="flex-1 text-[10px] text-muted-foreground/70">{action.description}</span>
                <span className="text-[9px] text-muted-foreground/50">↑↓ space a i</span>
              </div>

              {action.requiresInput === 'broadcast' && (
                <textarea
                  value={broadcastMessage}
                  onChange={e => setBroadcastMessage(e.target.value)}
                  placeholder="Message to broadcast to all selected conversations..."
                  rows={3}
                  className="w-full bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent text-xs font-mono"
                />
              )}
              {action.requiresInput === 'reassign' && (
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <input
                    placeholder="target projectUri (optional)"
                    value={reassignProject}
                    onChange={e => setReassignProject(e.target.value)}
                    className="bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent"
                  />
                  <select
                    value={reassignSentinel}
                    onChange={e => setReassignSentinel(e.target.value)}
                    className="bg-muted/20 px-2 py-1 border border-border/40"
                  >
                    <option value="">leave sentinel unchanged</option>
                    <option value="__clear__">clear sentinel (use default)</option>
                    {sentinels.map(s => (
                      <option key={s.sentinelId} value={s.sentinelId}>
                        {s.alias} ({s.sentinelId.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="target profile (blank=unchanged, __clear__=default)"
                    value={reassignProfile}
                    onChange={e => setReassignProfile(e.target.value)}
                    className="bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent"
                  />
                </div>
              )}

              {confirmRequired && (
                <input
                  placeholder={`type "confirm ${selectedIds.length}" to enable Run`}
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  className="w-full bg-amber-500/10 px-2 py-1 border border-amber-500/40 outline-none text-xs font-mono"
                />
              )}

              <div className="flex items-center justify-end gap-2">
                <span className="text-[10px] text-muted-foreground mr-auto">
                  {visibleSelected.length} of {convRows.length} visible selected
                </span>
                <button type="button" onClick={handleClose} className="px-3 py-1 text-xs bg-muted/20 hover:bg-muted/40">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canRun || !inputValid || !confirmOk}
                  onClick={handleRun}
                  className="px-3 py-1 text-xs font-bold bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Run on {selectedIds.length} selected
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BatchGroupHeader({ row, cols }: { row: GroupRow; cols: number }) {
  return (
    <tr className="bg-muted/15 border-y border-border/30">
      <td colSpan={cols} className="px-2 py-1">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
          {row.color && <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: row.color }} />}
          {row.icon && <span className="shrink-0 text-muted-foreground">{renderProjectIcon(row.icon, 'w-3 h-3')}</span>}
          <span className="text-foreground font-bold">{row.label}</span>
          <span className="text-muted-foreground/60">({row.count})</span>
        </div>
      </td>
    </tr>
  )
}

function BatchRow({
  row,
  idx,
  checked,
  focused,
  groupByProject,
  projectSettings,
  onActivate,
  onFocus,
}: {
  row: ConvRow
  idx: number
  checked: boolean
  focused: boolean
  groupByProject: boolean
  projectSettings: Record<string, ProjectSettings>
  onActivate: (idx: number, shift: boolean) => void
  onFocus: () => void
}) {
  const { conv } = row
  const projectLabel = projectLabelFor(conv, projectSettings)
  const ps = projectSettings[conv.project]
  const color = ps?.color
  const icon = ps?.icon

  return (
    <tr
      className={cn(
        'border-b border-border/20 cursor-pointer transition-colors',
        checked ? 'bg-accent/10 hover:bg-accent/15' : 'hover:bg-muted/10',
        focused && 'ring-1 ring-accent/40 ring-inset',
      )}
      style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
      onClick={e => onActivate(idx, e.shiftKey)}
      onMouseEnter={onFocus}
    >
      <td className="px-2 py-1" onClick={e => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onActivate(idx, (e.nativeEvent as MouseEvent).shiftKey)}
          aria-label={`Select ${conv.title || conv.id}`}
          className="cursor-pointer accent-accent"
        />
      </td>
      <td className="px-2 py-1">
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={conv.status} />
          <span className="truncate max-w-[14rem]">{conv.title || conv.id.slice(0, 8)}</span>
        </div>
      </td>
      {!groupByProject && (
        <td className="px-2 py-1 truncate max-w-[12rem]" title={conv.project}>
          <span className="inline-flex items-center gap-1.5">
            {icon && <span className="text-muted-foreground/80">{renderProjectIcon(icon, 'w-3 h-3')}</span>}
            <span>{projectLabel}</span>
          </span>
        </td>
      )}
      <td className="px-2 py-1 truncate max-w-[10rem]">
        <MutedDefault value={conv.hostSentinelAlias || conv.hostSentinelId} />
      </td>
      <td className="px-2 py-1">
        <MutedDefault value={conv.resolvedProfile} />
      </td>
      <td className="px-2 py-1 text-muted-foreground/80">{formatAge(conv.lastActivity)}</td>
    </tr>
  )
}
