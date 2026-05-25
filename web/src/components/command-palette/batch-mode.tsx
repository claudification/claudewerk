import { extractProjectLabel } from '@shared/project-uri'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { cn, formatAge } from '@/lib/utils'
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
  status: 'any' | 'live' | 'idle' | 'ended'
  sentinel: string
  text: string
}

function matchesStatus(status: Conversation['status'], filter: FilterState['status']): boolean {
  if (filter === 'any') return true
  if (filter === 'live') return status === 'active'
  if (filter === 'idle') return status === 'idle'
  return status === 'ended'
}

function matchesSentinel(c: Conversation, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  const hostId = (c.hostSentinelId ?? '').toLowerCase()
  const alias = (c.hostSentinelAlias ?? '').toLowerCase()
  return hostId.includes(needle) || alias.includes(needle)
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
      matchesStatus(c.status, filter.status) &&
      matchesSentinel(c, filter.sentinel) &&
      matchesText(c, filter.text),
  )
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
  const [filterStatus, setFilterStatus] = useState<'any' | 'live' | 'idle' | 'ended'>('any')
  const [filterSentinel, setFilterSentinel] = useState('')
  const [filterText, setFilterText] = useState('')
  const [selectedActionId, setSelectedActionId] = useState<string>(ALL_BATCH_ACTIONS[0]?.id ?? 'broadcast')
  const [confirmText, setConfirmText] = useState('')

  const [runningBatch, setRunningBatch] = useState<{
    batchId: string
    action: BatchAction
    ids: string[]
    input: unknown
  } | null>(null)
  // Action-specific input state
  const [broadcastMessage, setBroadcastMessage] = useState('')
  const [reassignProject, setReassignProject] = useState('')
  const [reassignSentinel, setReassignSentinel] = useState('')
  const [reassignProfile, setReassignProfile] = useState('')

  // Ensure a batchId exists once the modal is open.
  useEffect(() => {
    if (open && !currentBatchId) startBatch()
  }, [open, currentBatchId, startBatch])

  const action = ALL_BATCH_ACTIONS.find(a => a.id === selectedActionId) ?? ALL_BATCH_ACTIONS[0]

  const filtered = useMemo(
    () =>
      filterConversations(conversations, {
        project: filterProject,
        status: filterStatus,
        sentinel: filterSentinel,
        text: filterText,
      }),
    [conversations, filterProject, filterStatus, filterSentinel, filterText],
  )

  if (!isAdmin) return null

  const selectedIds = Array.from(selectedForBatch)
  const visibleSelected = filtered.filter(c => selectedForBatch.has(c.id))
  const allVisibleSelected = filtered.length > 0 && filtered.every(c => selectedForBatch.has(c.id))

  function handleSelectAllVisible() {
    const visibleIds = filtered.slice(0, SELECT_ALL_CAP).map(c => c.id)
    const next = new Set(selectedForBatch)
    for (const id of visibleIds) next.add(id)
    selectBatch(Array.from(next))
  }

  function handleSelectAllUnchecked() {
    if (filtered.length > SELECT_ALL_CAP && confirmText.trim() !== `select ${filtered.length}`) return
    selectBatch(filtered.map(c => c.id))
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
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col p-0 top-[10vh] translate-y-0">
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
                onChange={e => setFilterStatus(e.target.value as typeof filterStatus)}
                className="bg-muted/20 px-2 py-1 border border-border/40 outline-none"
              >
                <option value="any">any status</option>
                <option value="live">live</option>
                <option value="idle">idle</option>
                <option value="ended">ended</option>
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

            <div className="flex items-center justify-between px-3 py-1 border-b border-border/40 text-[10px] text-muted-foreground">
              <span>{filtered.length} matches</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSelectAllVisible}
                  className="px-2 py-0.5 bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  {allVisibleSelected ? 'Visible selected' : `Select visible (cap ${SELECT_ALL_CAP})`}
                </button>
                {filtered.length > SELECT_ALL_CAP && (
                  <>
                    <input
                      placeholder={`type "select ${filtered.length}"`}
                      value={confirmText}
                      onChange={e => setConfirmText(e.target.value)}
                      className="bg-muted/20 px-2 py-0.5 border border-border/40 outline-none w-40 text-[10px]"
                    />
                    <button
                      type="button"
                      disabled={confirmText.trim() !== `select ${filtered.length}`}
                      onClick={handleSelectAllUnchecked}
                      className="px-2 py-0.5 bg-amber-500/20 text-amber-400 disabled:opacity-40 hover:bg-amber-500/30"
                    >
                      Apply to all {filtered.length}
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
                <thead className="sticky top-0 bg-surface-inset border-b border-border/40 text-[10px] text-muted-foreground uppercase">
                  <tr>
                    <th className="w-8 text-left px-2 py-1"> </th>
                    <th className="text-left px-2 py-1">title</th>
                    <th className="text-left px-2 py-1">status</th>
                    <th className="text-left px-2 py-1">project</th>
                    <th className="text-left px-2 py-1">sentinel</th>
                    <th className="text-left px-2 py-1">profile</th>
                    <th className="text-left px-2 py-1">last</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(c => {
                    const checked = selectedForBatch.has(c.id)
                    const projectLabel = projectSettings[c.project]?.label || extractProjectLabel(c.project)
                    return (
                      <tr
                        key={c.id}
                        className={cn('border-b border-border/20 hover:bg-muted/10', checked && 'bg-accent/5')}
                      >
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleBatchSelection(c.id)}
                            aria-label={`Select ${c.title || c.id}`}
                            className="cursor-pointer accent-accent"
                          />
                        </td>
                        <td className="px-2 py-1 truncate max-w-[14rem]">{c.title || c.id.slice(0, 8)}</td>
                        <td className="px-2 py-1">{c.status}</td>
                        <td className="px-2 py-1 truncate max-w-[12rem]" title={c.project}>
                          {projectLabel}
                        </td>
                        <td className="px-2 py-1 truncate max-w-[10rem]">
                          {c.hostSentinelAlias || c.hostSentinelId || '-'}
                        </td>
                        <td className="px-2 py-1">{c.resolvedProfile || 'default'}</td>
                        <td className="px-2 py-1">{formatAge(c.lastActivity)}</td>
                      </tr>
                    )
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
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
                  {visibleSelected.length} of {filtered.length} visible selected
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
