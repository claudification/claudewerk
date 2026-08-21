/**
 * TaskBatchSelector - Modal for cherry-picking project tasks and submitting them
 * as a structured work list to the current conversation, or copying as markdown.
 *
 * Entry points:
 * - Project board header button
 * - Conversation context menu ("Assign tasks...")
 * - Mobile FAB action
 * - Command palette
 *
 * All fire `window.dispatchEvent(new Event('open-batch-selector'))`
 */

import { cardRelPath } from '@shared/card-path'
import { openEpicRoster, wantsEpicRoster } from '@shared/epic-roster'
import { TASK_MODES, type TaskMode, taskMode } from '@shared/task-modes'
import { Fzf } from 'fzf'
import { CheckSquare, Copy, Info, ListChecks, Search, Send, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { sendInput, useConversations, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectTask, ProjectTaskMeta, TaskStatus } from '@/hooks/use-project'
import { useProject } from '@/hooks/use-project'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from './markdown'
import { batchOpenState, buildBatchPrompt } from './task-batch/prompt'
import { resolveBatchTargets } from './task-batch/target'
import { type TaskBatchOpen, taskBatchBus } from './task-batch-trigger'

// --- Constants ---

const TAG_COLORS = [
  'bg-primary/20 text-primary border-primary/30',
  'bg-event-prompt/20 text-event-prompt border-event-prompt/30',
  'bg-info/20 text-info border-info/30',
  'bg-active/20 text-active border-active/30',
  'bg-accent/20 text-accent border-accent/30',
  'bg-destructive/20 text-destructive border-destructive/30',
]

function tagColor(tag: string): string {
  let hash = 0
  for (const ch of tag) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-red-400',
  medium: 'bg-amber-400',
  low: 'bg-blue-400',
}

const STATUS_CHIPS: { status: TaskStatus; label: string; defaultOn: boolean }[] = [
  { status: 'inbox', label: 'inbox', defaultOn: true },
  { status: 'open', label: 'open', defaultOn: true },
  { status: 'in-progress', label: 'in-progress', defaultOn: false },
  { status: 'in-review', label: 'in-review', defaultOn: false },
]

/** Fuzzy score boost by status -- open tasks float higher */
function batchStatusBoost(status: string): number {
  switch (status) {
    case 'open':
      return 1.2
    case 'inbox':
      return 1.1
    case 'in-progress':
      return 1.0
    case 'in-review':
      return 0.9
    default:
      return 0.8
  }
}

/** Priority sort weight -- high first */
function priorityWeight(p?: string): number {
  switch (p) {
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    default:
      return 0
  }
}

// --- Search Logic ---

interface ParsedQuery {
  tags: string[][] // Array of OR-groups, e.g. [["refactor"], ["frontend", "backend"]]
  text: string
}

/** Parse search query: #tag tokens become AND-ed tag filters, #a|#b becomes OR */
function parseQuery(raw: string): ParsedQuery {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const tagGroups: string[][] = []
  const textParts: string[] = []

  for (const token of tokens) {
    if (token.startsWith('#')) {
      // Could be #a|#b for OR
      const orTags: string[] = []
      for (const t of token.split('|')) {
        const stripped = t.replace(/^#/, '').toLowerCase()
        if (stripped) orTags.push(stripped)
      }
      if (orTags.length > 0) tagGroups.push(orTags)
    } else {
      textParts.push(token)
    }
  }

  return { tags: tagGroups, text: textParts.join(' ') }
}

/** Check if a task matches all tag filter groups (AND between groups, OR within) */
function matchesTagFilters(task: ProjectTaskMeta, tagGroups: string[][]): boolean {
  if (tagGroups.length === 0) return true
  const taskTags = task.tags.map(t => t.toLowerCase())
  return tagGroups.every(orGroup => orGroup.some(filterTag => taskTags.some(t => t.startsWith(filterTag))))
}

/** Score and sort tasks for batch selector with tag filtering + status boost */
function scoreTasks(tasks: ProjectTaskMeta[], query: string): ProjectTaskMeta[] {
  const { tags, text } = parseQuery(query)

  // First: filter by tags (exact prefix match)
  const tagFiltered = tags.length > 0 ? tasks.filter(t => matchesTagFilters(t, tags)) : tasks

  if (!text) {
    // No fuzzy text -- sort by priority then status boost
    return tagFiltered.toSorted((a, b) => {
      const pw = priorityWeight(b.priority) - priorityWeight(a.priority)
      if (pw !== 0) return pw
      return batchStatusBoost(b.status) - batchStatusBoost(a.status)
    })
  }

  // Fuzzy match on text portion
  const fzf = new Fzf(tagFiltered, {
    selector: (t: ProjectTaskMeta) => `${t.title} ${t.slug}`,
    casing: 'case-insensitive',
  })

  return fzf
    .find(text)
    .sort((a, b) => {
      // Primary: priority
      const pw = priorityWeight(b.item.priority) - priorityWeight(a.item.priority)
      if (pw !== 0) return pw
      // Secondary: fuzzy score * status boost
      return b.score * batchStatusBoost(b.item.status) - a.score * batchStatusBoost(a.item.status)
    })
    .map(r => r.item)
}

// --- Hover Preview ---

const HOVER_DELAY_MS = 4000

function TaskPreviewPopover({ task, anchorRect }: { task: ProjectTask; anchorRect: DOMRect }) {
  const style: React.CSSProperties = {
    position: 'fixed',
    left: anchorRect.right + 8,
    top: anchorRect.top,
    maxWidth: 380,
    maxHeight: 400,
    zIndex: 9999,
  }

  // If popover would overflow right edge, show on the left instead
  if (anchorRect.right + 388 > window.innerWidth) {
    style.left = anchorRect.left - 388
  }

  // Clamp top so it doesn't overflow bottom
  if (anchorRect.top + 400 > window.innerHeight) {
    style.top = Math.max(8, window.innerHeight - 408)
  }

  return (
    <div
      style={style}
      className="bg-surface-inset border border-primary/20 rounded-lg shadow-xl overflow-hidden animate-in fade-in duration-150"
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-primary/12">
        <div className="text-xs font-mono text-foreground font-bold">{task.title}</div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className="text-[9px] font-mono text-fg-dim">{task.status}</span>
          {task.priority && (
            <span
              className={cn(
                'text-[9px] px-1 py-0.5 border font-mono',
                task.priority === 'high' && 'border-red-400/40 text-red-400',
                task.priority === 'medium' && 'border-amber-400/40 text-amber-400',
                task.priority === 'low' && 'border-blue-400/40 text-blue-400',
              )}
            >
              {task.priority}
            </span>
          )}
          {task.tags.map(tag => (
            <span key={tag} className={cn('px-1 py-px text-[9px] font-mono border rounded', tagColor(tag))}>
              {tag}
            </span>
          ))}
        </div>
      </div>
      {/* Body */}
      <div className="px-3 py-2 overflow-y-auto max-h-[320px]">
        {task.body.trim() ? (
          <div className="text-xs text-foreground/80 prose prose-invert prose-xs max-w-none">
            <Markdown>{task.body}</Markdown>
          </div>
        ) : (
          <div className="text-[10px] text-fg-faint font-mono italic">No content</div>
        )}
      </div>
    </div>
  )
}

// --- Component ---

export const TaskBatchSelector = memo(function TaskBatchSelector() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Non-null when a caller opened us for a subset of the board (e.g. one epic). */
  const [scope, setScope] = useState<{ ids: Set<string>; label?: string } | null>(null)
  const [activeStatuses, setActiveStatuses] = useState<Set<TaskStatus>>(() => {
    const out = new Set<TaskStatus>()
    for (const c of STATUS_CHIPS) {
      if (c.defaultOn) out.add(c.status)
    }
    return out
  })
  const [templateId, setTemplateId] = useState<TaskMode>('work')
  const [customInstructions, setCustomInstructions] = useState(TASK_MODES[0].instructions)
  const [showSelected, setShowSelected] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** Pinned by the dispatch site (a board hands us its own conversation), so a
   *  board scoped to one project never reads or sends against another's. */
  const [pinnedConversationId, setPinnedConversationId] = useState<string | null>(null)
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const conversations = useConversations()
  const { relay: relayConversationId, target: targetConversationId } = useMemo(
    () => resolveBatchTargets(conversations, pinnedConversationId, selectedConversationId),
    [conversations, pinnedConversationId, selectedConversationId],
  )

  const { tasks, readTask } = useProject(relayConversationId)

  // Hover preview state
  const [previewTask, setPreviewTask] = useState<ProjectTask | null>(null)
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverSlugRef = useRef<string | null>(null)

  const clearHoverPreview = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    hoverSlugRef.current = null
    setPreviewTask(null)
    setPreviewRect(null)
  }, [])

  function handleTaskMouseEnter(task: ProjectTaskMeta, el: HTMLElement) {
    clearHoverPreview()
    hoverSlugRef.current = task.slug
    hoverTimerRef.current = setTimeout(async () => {
      if (hoverSlugRef.current !== task.slug) return
      const full = await readTask(task.slug)
      if (full && hoverSlugRef.current === task.slug) {
        setPreviewTask(full)
        setPreviewRect(el.getBoundingClientRect())
      }
    }, HOVER_DELAY_MS)
  }

  function handleTaskMouseLeave() {
    clearHoverPreview()
  }

  async function handleInfoClick(task: ProjectTaskMeta, el: HTMLElement) {
    haptic('tap')
    // Toggle off if already showing this task
    if (previewTask?.slug === task.slug) {
      clearHoverPreview()
      return
    }
    clearHoverPreview()
    hoverSlugRef.current = task.slug
    const full = await readTask(task.slug)
    if (full && hoverSlugRef.current === task.slug) {
      setPreviewTask(full)
      setPreviewRect(el.getBoundingClientRect())
    }
  }

  // Clean up hover timer on unmount or close
  useEffect(() => {
    if (!open) clearHoverPreview()
  }, [open, clearHoverPreview])

  // Template switching
  const switchTemplate = useCallback((id: TaskMode) => {
    const spec = taskMode(id)
    setTemplateId(spec.id)
    setCustomInstructions(spec.instructions)
  }, [])

  // Listen for open event. A caller may hand us a scope + a preselection + a
  // mode -- that is how "work on this epic" arrives with its not-started cards
  // already ticked instead of making you find them again, and how an epic's
  // REFINE lands on the refine template instead of silently on work.
  useEffect(() => {
    function handleOpen(detail?: TaskBatchOpen) {
      const next = batchOpenState(detail)
      setOpen(true)
      setQuery('')
      setShowSelected(false)
      setScope(next.scope)
      setSelected(next.selected)
      setPinnedConversationId(detail?.conversationId ?? null)
      switchTemplate(next.mode)
      // This selector is mounted in the app shell, so a dispatch from a DETACHED
      // surface opens it in the opener window -- behind the popup the click came
      // from. Best-effort raise: without it the action looks like it did nothing.
      window.focus()
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    taskBatchBus.setHandler(handleOpen)
    return () => taskBatchBus.setHandler(null)
  }, [switchTemplate])

  // Filter tasks by scope, then active status chips, then score
  const visibleTasks = useMemo(() => {
    const scoped = scope ? tasks.filter(t => scope.ids.has(t.slug)) : tasks
    const statusFiltered = scoped.filter(t => activeStatuses.has(t.status))
    return scoreTasks(statusFiltered, query)
  }, [tasks, scope, activeStatuses, query])

  // Get selected task objects (preserving selection order)
  const selectedTasks = useMemo(() => {
    const bySlug = new Map(tasks.map(t => [t.slug, t]))
    const selectedArray: ProjectTaskMeta[] = []
    for (const slug of selected) {
      const task = bySlug.get(slug)
      if (task) selectedArray.push(task)
    }
    return selectedArray
  }, [selected, tasks])

  const toggleTask = useCallback((slug: string) => {
    haptic('tap')
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }, [])

  const removeTask = useCallback((slug: string) => {
    haptic('tap')
    setSelected(prev => {
      const next = new Set(prev)
      next.delete(slug)
      return next
    })
  }, [])

  const toggleStatus = useCallback((status: TaskStatus) => {
    haptic('tap')
    setActiveStatuses(prev => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }, [])

  /**
   * The open-epic roster, sent only when this batch can act on it: a REFINE of
   * a selection containing at least one card with no `epic:` yet. A work or
   * analyze batch never parents anything, and a selection where every card is
   * already parented has nothing to soft-link -- both would be paying for a
   * board dump the agent cannot use.
   *
   * Built from `tasks` (the whole board), not from `selectedTasks`: the epics a
   * card should join are almost never inside the batch you selected.
   */
  const epicRoster = useMemo(
    () => (wantsEpicRoster(templateId === 'refine', selectedTasks) ? openEpicRoster(tasks) : ''),
    [templateId, selectedTasks, tasks],
  )

  // Build final prompt
  const finalPrompt = useMemo(
    () => buildBatchPrompt(customInstructions, selectedTasks, epicRoster),
    [customInstructions, selectedTasks, epicRoster],
  )

  // Actions
  function handleSubmit() {
    if (!targetConversationId || selectedTasks.length === 0) return
    haptic('success')
    sendInput(targetConversationId, finalPrompt)
    setOpen(false)
    setSelected(new Set())
  }

  function handleCopy() {
    if (selectedTasks.length === 0) return
    haptic('tap')
    navigator.clipboard.writeText(finalPrompt).catch(() => {
      // Fallback
      const ta = document.createElement('textarea')
      ta.value = finalPrompt
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    })
  }

  function handleClose() {
    setOpen(false)
  }

  // Radix handles Escape natively; we keep mod+Enter for submit inside the dialog.
  useKeyLayer(
    {
      'mod+Enter': () => handleSubmit(),
    },
    { id: 'batch-selector', enabled: open },
  )

  // `resolveBatchTargets` already refused to name an ended conversation, so a
  // non-null target IS a live one.
  const hasActiveConversation = !!targetConversationId

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col overflow-hidden rounded-lg p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-accent" />
            <DialogTitle className="text-sm">Select Tasks</DialogTitle>
            {scope && (
              <span
                className="text-[9px] font-mono px-1 py-0.5 border border-accent/30 text-accent/80 max-w-[180px] truncate"
                title={`Scoped to ${scope.ids.size} card(s)`}
              >
                ◈ {scope.label ?? `${scope.ids.size} cards`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Kbd className="text-[9px]">Esc</Kbd>
          </div>
        </div>

        {/* Search + status chips */}
        <div className="px-4 py-2 border-b border-border-subtle space-y-2">
          <div className="flex items-center gap-2">
            <Search className="size-3.5 text-fg-faint shrink-0" />
            <input
              ref={searchRef}
              aria-label="Search tasks"
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => haptic('tap')}
              placeholder="Search tasks... (#tag for filter)"
              className="flex-1 bg-transparent text-xs font-mono text-foreground outline-none placeholder:text-fg-faint"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                className="text-fg-faint hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {STATUS_CHIPS.map(chip => (
              <button
                key={chip.status}
                type="button"
                onClick={() => toggleStatus(chip.status)}
                className={cn(
                  'px-2 py-0.5 text-[10px] font-mono border rounded transition-colors',
                  activeStatuses.has(chip.status)
                    ? 'border-accent/50 text-accent bg-accent/10'
                    : 'border-border-subtle text-fg-faint hover:text-fg-dim',
                )}
              >
                {chip.label}
              </button>
            ))}
            {scope && (
              <button
                type="button"
                onClick={() => {
                  haptic('tap')
                  setScope(null)
                }}
                className="text-[10px] font-mono text-fg-faint hover:text-foreground"
              >
                show whole board
              </button>
            )}
            <span className="ml-auto text-[10px] text-fg-faint font-mono">{visibleTasks.length} tasks</span>
          </div>
        </div>

        {/* Task list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {visibleTasks.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-fg-faint text-xs font-mono">No tasks match</div>
          ) : (
            visibleTasks.map(task => {
              const isSelected = selected.has(task.slug)
              return (
                <div
                  key={task.slug}
                  className={cn(
                    'flex items-start border-b border-border-subtle transition-colors',
                    'hover:bg-accent/5',
                    isSelected && 'bg-accent/10',
                  )}
                  onMouseEnter={e => handleTaskMouseEnter(task, e.currentTarget)}
                  onMouseLeave={handleTaskMouseLeave}
                >
                  <button
                    type="button"
                    onClick={() => toggleTask(task.slug)}
                    className="flex-1 flex items-start gap-2.5 px-4 py-2 text-left min-w-0"
                  >
                    {/* Checkbox */}
                    <div
                      className={cn(
                        'w-4 h-4 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors',
                        isSelected ? 'border-accent bg-accent/20 text-accent' : 'border-border text-transparent',
                      )}
                    >
                      {isSelected && <CheckSquare className="size-3" />}
                    </div>

                    {/* Task info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {task.priority && (
                          <span
                            className={cn('w-1.5 h-1.5 rounded-full shrink-0', PRIORITY_DOT[task.priority] || '')}
                          />
                        )}
                        <span className="text-xs font-mono text-foreground truncate">{task.title}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                        <span className="text-[9px] font-mono text-fg-faint">{task.status}</span>
                        {task.tags.map(tag => (
                          <span
                            key={tag}
                            className={cn('px-1 py-px text-[9px] font-mono border rounded', tagColor(tag))}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      handleInfoClick(task, e.currentTarget)
                    }}
                    className="shrink-0 px-2 py-2.5 text-fg-faint hover:text-fg-muted transition-colors"
                    title="Preview task"
                  >
                    <Info className="size-3" />
                  </button>
                </div>
              )
            })
          )}
        </div>

        {/* Selected badge + prompt area */}
        <div className="border-t border-border">
          {/* Selection count + expand */}
          {selected.size > 0 && (
            <div className="px-4 py-2 border-b border-border-subtle">
              <button
                type="button"
                onClick={() => {
                  haptic('tap')
                  setShowSelected(prev => !prev)
                }}
                className="flex items-center gap-1.5 text-xs font-mono text-accent"
              >
                <span className="font-bold">{selected.size} selected</span>
                <span className={cn('transition-transform', showSelected && 'rotate-180')}>&#9662;</span>
              </button>

              {/* Expanded selection list */}
              {showSelected && (
                <div className="mt-1.5 space-y-0.5 max-h-24 overflow-y-auto">
                  {selectedTasks.map(task => (
                    <div key={task.slug} className="flex items-center gap-2 group">
                      <span className="text-[10px] font-mono text-foreground/80 truncate flex-1">{task.title}</span>
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation()
                          removeTask(task.slug)
                        }}
                        className="opacity-0 group-hover:opacity-100 text-fg-faint hover:text-red-400 transition-opacity"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Prompt template selector + editable area */}
          {selected.size > 0 && (
            <div className="px-4 py-2 space-y-2">
              {/* Template radio buttons */}
              <div className="flex items-center gap-3">
                {TASK_MODES.map(tmpl => (
                  <label key={tmpl.id} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="batch-template"
                      checked={templateId === tmpl.id}
                      onChange={() => {
                        haptic('tap')
                        switchTemplate(tmpl.id)
                      }}
                      className="size-3 accent-accent"
                    />
                    <span
                      className={cn(
                        'text-[10px] font-mono',
                        templateId === tmpl.id ? 'text-accent font-bold' : 'text-fg-dim',
                      )}
                    >
                      {tmpl.label}
                    </span>
                  </label>
                ))}
              </div>

              {/* Editable instructions textarea */}
              <textarea
                ref={textareaRef}
                aria-label="Custom instructions for batch task launch"
                value={customInstructions}
                onChange={e => setCustomInstructions(e.target.value)}
                rows={4}
                className="w-full bg-background border border-primary/15 rounded px-2.5 py-2 text-[11px] font-mono text-foreground/80 outline-none resize-y placeholder:text-fg-faint focus:border-accent/50"
              />

              {/* Task list preview (read-only) */}
              <div className="bg-background border border-primary/12 rounded px-2.5 py-1.5 max-h-20 overflow-y-auto">
                <div className="text-[10px] font-mono text-fg-faint mb-1">Tasks:</div>
                {selectedTasks.map(task => (
                  <div key={task.slug} className="text-[10px] font-mono text-foreground/60 leading-relaxed">
                    <span className="text-foreground/80">- {task.title}</span>
                    {task.priority && <span className="text-fg-faint"> ({task.priority})</span>}
                    <div className="text-fg-faint pl-2">{cardRelPath(task.slug)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 px-4 py-3">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasActiveConversation || selected.size === 0}
              title={
                !hasActiveConversation
                  ? 'No active conversation'
                  : selected.size === 0
                    ? 'Select tasks first'
                    : 'Submit to current conversation'
              }
              className={cn(
                'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-mono font-bold transition-colors',
                hasActiveConversation && selected.size > 0
                  ? 'bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 active:scale-[0.98]'
                  : 'bg-background text-fg-faint border border-border-subtle cursor-not-allowed',
              )}
            >
              <Send className="size-3.5" />
              Submit to conversation
              <Kbd className="ml-1 text-[9px]">⌘↵</Kbd>
            </button>
            <button
              type="button"
              onClick={handleCopy}
              disabled={selected.size === 0}
              title={selected.size === 0 ? 'Select tasks first' : 'Copy as markdown'}
              className={cn(
                'flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-mono transition-colors',
                selected.size > 0
                  ? 'text-muted-foreground border border-border-subtle hover:text-foreground hover:border-border active:scale-[0.98]'
                  : 'text-fg-faint border border-border-subtle cursor-not-allowed',
              )}
            >
              <Copy className="size-3.5" />
              Copy
            </button>
          </div>
        </div>
      </DialogContent>
      {previewTask && previewRect && <TaskPreviewPopover task={previewTask} anchorRect={previewRect} />}
    </Dialog>
  )
})
