/**
 * Project Board - Kanban-style view for project tasks
 * Three columns: Open | In Progress | Done, plus collapsible Archive
 */

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { buildEpicIndex, type EpicRollup, notStartedChildren } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ListChecks,
  MoreHorizontal,
  RotateCcw,
  Search,
  Sliders,
  Trash2,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BOARD_MODES,
  type BoardViewConfig,
  CLAMP_CLASS,
  DENSITY_PADDING,
  TITLE_SIZE_CLASS,
  useBoardViewConfig,
} from '@/hooks/use-board-view-config'
import { useCardDeepLink } from '@/hooks/use-card-deeplink'
import { useConversationsStore } from '@/hooks/use-conversations'
import { enqueueNightshiftTask } from '@/hooks/use-nightshift-queue'
import type { ProjectTask } from '@/hooks/use-project'
import { type ProjectTaskMeta, type TaskStatus, useProject } from '@/hooks/use-project'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { extractProjectLabel } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { InputEditor } from './input-editor'
import {
  CHIP_IDLE,
  NEXT_STATUS,
  PREV_STATUS,
  PRIORITY_COLORS,
  TASK_COLUMNS,
  tagColor,
  taskAge,
} from './project-board/board-constants'
import { CardActions } from './project-board/card-actions'
import { EpicBadge } from './project-board/epic-badge'
import { EpicsView } from './project-board/epics-view'
import { InlineAdd } from './project-board/inline-add'
import { RunTaskDialog } from './project-board/run-task-dialog'
import { TaskEditor } from './project-board/task-editor'
import { openTaskBatch } from './task-batch-trigger'

/** The board header's project name label, resolved from the conversation. Kept
 *  as its own component so the (already large) ProjectBoard gains no hook. */
function BoardHeaderLabel({ conversationId }: { conversationId: string }) {
  const label = useConversationsStore(s => {
    const uri = s.conversationsById[conversationId]?.project
    return (uri && extractProjectLabel(uri)) || 'Board'
  })
  return (
    <span className="text-xs font-bold text-foreground font-mono truncate" title={label}>
      {label}
    </span>
  )
}

function matchesTextFilter(query: string, task: ProjectTaskMeta): boolean {
  if (!query) return true
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const title = task.title.toLowerCase()
  return terms.every(term => title.includes(term))
}

/** Get unique tags from all tasks, sorted by frequency (descending) */
function getTagFrequencies(tasks: ProjectTaskMeta[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const tag of task.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

function ProjectCard({
  task,
  view,
  epicRollup,
  onMove,
  onDelete,
  onArchive,
  onEdit,
  onOpenSlug,
}: {
  task: ProjectTaskMeta
  view: BoardViewConfig
  /** The parent epic's rollup, when this card belongs to one. */
  epicRollup?: EpicRollup
  onMove: (id: string, to: TaskStatus) => void
  onDelete: (id: string) => void
  onArchive: (id: string) => void
  onEdit: (task: ProjectTaskMeta) => void
  onOpenSlug: (slug: string) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${task.status}/${task.slug}`,
    data: { slug: task.slug, status: task.status },
  })

  // A card wears its epic's colour as a left rail, so LANES mode says which
  // epic a card belongs to without opening anything. Unparented cards get no
  // rail at all -- absence is the signal, a grey rail would just be noise.
  const style = {
    ...(transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : {}),
    ...(task.epic ? epicColorVars(epicHue(task.epic, epicRollup?.card?.color)) : {}),
  }

  return (
    // task card carries dnd-kit drag handlers + nested action buttons; semantic <button> would nest buttons
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group bg-surface-inset border border-border/70 hover:border-primary/45 transition-colors cursor-pointer',
        task.epic && 'border-l-2 border-l-[color:var(--epic-solid)]',
        DENSITY_PADDING[view.density],
        isDragging && 'opacity-50 z-50',
      )}
      onClick={() => !isDragging && onEdit(task)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onEdit(task)
      }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div
            className={cn(
              'font-mono text-foreground truncate flex items-center gap-1.5',
              TITLE_SIZE_CLASS[view.titleSize],
            )}
          >
            <span className="truncate">{task.title}</span>
            {task.created && (
              <span className="text-[9px] text-muted-foreground/65 shrink-0">{taskAge(task.created)}</span>
            )}
          </div>
          {task.bodyPreview && view.bodyLines > 0 && (
            <div className={cn('text-[10px] text-muted-foreground mt-0.5', CLAMP_CLASS[view.bodyLines])}>
              {task.bodyPreview}
            </div>
          )}
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {task.epic && <EpicBadge epicId={task.epic} rollup={epicRollup} onOpen={onOpenSlug} />}
            {task.priority && (
              <span className={cn('text-[9px] px-1 py-0.5 border font-mono', PRIORITY_COLORS[task.priority])}>
                {task.priority}
              </span>
            )}
            {task.tags.map(tag => (
              <span key={tag} className={cn('text-[9px] px-1 py-0.5 border font-mono', tagColor(tag))}>
                {tag}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 p-0.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          onClick={e => {
            e.stopPropagation()
            haptic('tap')
            setShowActions(!showActions)
          }}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>

      {showActions && (
        <CardActions
          task={task}
          onMove={onMove}
          onArchive={onArchive}
          onDelete={onDelete}
          onDone={() => setShowActions(false)}
        />
      )}
    </div>
  )
}

function DroppableColumn({
  status,
  width,
  children,
}: {
  status: TaskStatus
  width: number
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div
      ref={setNodeRef}
      style={{ width: `${width}px`, minWidth: `${width}px` }}
      className={cn(
        'flex-1 flex flex-col border-r border-border last:border-r-0 transition-colors',
        isOver && 'bg-accent/5',
      )}
    >
      {children}
    </div>
  )
}

function ViewConfigPanel({
  view,
  update,
  reset,
}: {
  view: BoardViewConfig
  update: <K extends keyof BoardViewConfig>(key: K, value: BoardViewConfig[K]) => void
  reset: () => void
}) {
  return (
    <div className="border border-border/70 bg-surface-inset/60 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60">View</span>
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            reset()
          }}
          className="flex items-center gap-1 text-[9px] font-mono text-muted-foreground/60 hover:text-foreground transition-colors"
          title="Reset to defaults"
        >
          <RotateCcw className="size-3" />
          Reset
        </button>
      </div>

      <label className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-muted-foreground/70 w-16 shrink-0">Width</span>
        <input
          type="range"
          min={200}
          max={400}
          step={10}
          value={view.columnWidth}
          onChange={e => update('columnWidth', Number(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="text-[10px] font-mono text-foreground w-10 text-right">{view.columnWidth}px</span>
      </label>

      <label className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-muted-foreground/70 w-16 shrink-0">Body</span>
        <input
          type="range"
          min={0}
          max={6}
          step={1}
          value={view.bodyLines}
          onChange={e => update('bodyLines', Number(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="text-[10px] font-mono text-foreground w-10 text-right">
          {view.bodyLines === 0 ? 'hidden' : `${view.bodyLines}L`}
        </span>
      </label>

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-muted-foreground/70 w-16 shrink-0">Density</span>
        <div className="flex gap-1 flex-1">
          {(['compact', 'normal', 'roomy'] as const).map(d => (
            <button
              key={d}
              type="button"
              onClick={() => update('density', d)}
              className={cn(
                'flex-1 px-2 py-0.5 text-[9px] font-mono border rounded transition-colors',
                view.density === d ? 'border-accent/60 text-accent bg-accent/10' : CHIP_IDLE,
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-muted-foreground/70 w-16 shrink-0">Title</span>
        <div className="flex gap-1 flex-1">
          {(['xs', 'sm'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => update('titleSize', s)}
              className={cn(
                'flex-1 px-2 py-0.5 text-[9px] font-mono border rounded transition-colors',
                view.titleSize === s ? 'border-accent/60 text-accent bg-accent/10' : CHIP_IDLE,
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// Pre-existing god-component (cognitive was 38 before this change; extracting
// BoardHeaderLabel dropped it to 36). Touching it re-attributes the inherited
// complexity as "introduced" under the line-based new-only gate; a real split of
// this 1700-line file is out of scope for the Kanban-modal change.
// fallow-ignore-next-line complexity
export const ProjectBoard = memo(function ProjectBoard({ conversationId }: { conversationId: string }) {
  const { projectUri, tasks, loading, refresh, createTask, moveTask, deleteTask, readTask, updateTask } =
    useProject(conversationId)
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null)
  const [runTask, setRunTask] = useState<ProjectTask | null>(null)
  const [activeDragTask, setActiveDragTask] = useState<ProjectTaskMeta | null>(null)
  const [archiveExpanded, setArchiveExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const { config: view, update: updateView, reset: resetView } = useBoardViewConfig()
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [selectedPriority, setSelectedPriority] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Sync editingTask metadata when tasks list updates (e.g. project_changed from another conversation)
  // Preserves body text to avoid overwriting user edits
  useEffect(() => {
    if (!editingTask) return
    const updated = tasks.find(t => t.slug === editingTask.slug)
    if (updated && (updated.status !== editingTask.status || updated.priority !== editingTask.priority)) {
      setEditingTask(prev =>
        prev ? { ...prev, status: updated.status, priority: updated.priority, tags: updated.tags } : prev,
      )
    }
  }, [tasks, editingTask])

  // Deep links (push notification, #task/<id>, a `.rclaude/project/...` markdown
  // link) -- resolved by slug once the manifest has landed. See the hook.
  useCardDeepLink({ ready: !!projectUri, readTask, onOpen: setEditingTask })

  // One fold over the cards the board already holds -- no extra I/O, and the
  // lane cards and the EPICS view read the same numbers by construction.
  const epicIndex = useMemo(() => buildEpicIndex(tasks), [tasks])

  const openCardBySlug = useCallback(
    async (slug: string) => {
      const full = await readTask(slug)
      if (full) setEditingTask(full)
    },
    [readTask],
  )

  /** Hand the EXISTING batch selector this epic's not-started children, ticked. */
  const handleWorkOnEpic = useCallback(
    (epicId: string) => {
      const rollup = epicIndex.get(epicId)
      if (!rollup) return
      openTaskBatch({
        scope: rollup.children.map(c => c.card.slug),
        preselect: notStartedChildren(rollup).map(c => c.slug),
        scopeLabel: rollup.card?.title ?? epicId,
      })
    },
    [epicIndex],
  )

  const tagFreqs = useMemo(() => getTagFrequencies(tasks), [tasks])
  const hasActiveFilters = searchQuery.trim() || selectedTags.size > 0 || selectedPriority

  const filteredTasks = useMemo(() => {
    return tasks.filter(task => {
      if (!matchesTextFilter(searchQuery, task)) return false
      if (selectedTags.size > 0 && !task.tags.some(t => selectedTags.has(t))) return false
      if (selectedPriority && task.priority !== selectedPriority) return false
      return true
    })
  }, [tasks, searchQuery, selectedTags, selectedPriority])

  function toggleTag(tag: string) {
    setSelectedTags(prev => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
    haptic('tap')
  }

  function togglePriority(p: string) {
    setSelectedPriority(prev => (prev === p ? null : p))
    haptic('tap')
  }

  function clearFilters() {
    setSearchQuery('')
    setSelectedTags(new Set())
    setSelectedPriority(null)
    haptic('tap')
  }

  // Ctrl+F / Cmd+F opens filter and focuses search input
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  )

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!data) return
    const task = tasks.find(n => n.slug === data.slug && n.status === data.status)
    if (task) setActiveDragTask(task)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragTask(null)
    const { active, over } = event
    if (!over) return
    const targetStatus = over.id as TaskStatus
    const sourceData = active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!sourceData || sourceData.status === targetStatus) return
    haptic('tap')
    moveTask(sourceData.slug, targetStatus)
  }

  const handleCreate = useCallback(
    async (text: string) => {
      const lines = text.split('\n')
      const title = lines[0]
      const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text
      await createTask({ title, body })
    },
    [createTask],
  )

  const handleMove = useCallback(
    async (id: string, to: TaskStatus) => {
      await moveTask(id, to)
    },
    [moveTask],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteTask(id)
    },
    [deleteTask],
  )

  const handleArchive = useCallback(
    async (id: string) => {
      await moveTask(id, 'archived')
    },
    [moveTask],
  )

  /** One card, wired to the board's handlers. Same everywhere it renders --
   *  the columns and the archive drawer must not drift apart. */
  const renderCard = useCallback(
    (task: ProjectTaskMeta) => (
      <ProjectCard
        key={task.slug}
        task={task}
        view={view}
        epicRollup={task.epic ? epicIndex.get(task.epic) : undefined}
        onMove={handleMove}
        onDelete={handleDelete}
        onArchive={handleArchive}
        onEdit={meta => void openCardBySlug(meta.slug)}
        onOpenSlug={slug => void openCardBySlug(slug)}
      />
    ),
    [view, epicIndex, handleMove, handleDelete, handleArchive, openCardBySlug],
  )

  const archivedTasks = filteredTasks.filter(n => n.status === 'archived')
  const activeTasks = filteredTasks.filter(n => n.status !== 'archived')

  if (loading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground/80 text-xs font-mono">Loading…</div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex flex-col border-b border-border shrink-0">
        <div className="flex items-center justify-between px-3 py-2">
          <BoardHeaderLabel conversationId={conversationId} />
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-border/70">
              {BOARD_MODES.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    haptic('tap')
                    updateView('mode', m)
                  }}
                  className={cn(
                    'px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider transition-colors',
                    view.mode === m ? 'bg-accent/15 text-accent' : 'text-muted-foreground/80 hover:text-foreground',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <button
              type="button"
              title="Batch select tasks"
              className="p-0.5 text-muted-foreground/60 hover:text-accent transition-colors"
              onClick={() => {
                haptic('tap')
                openTaskBatch()
              }}
            >
              <ListChecks className="size-3.5" />
            </button>
            <button
              type="button"
              className={cn(
                'p-0.5 transition-colors',
                searchOpen ? 'text-accent' : 'text-muted-foreground/60 hover:text-foreground',
              )}
              onClick={() => {
                haptic('tap')
                setSearchOpen(prev => {
                  if (!prev) {
                    requestAnimationFrame(() => searchRef.current?.focus())
                  } else {
                    setSearchQuery('')
                  }
                  return !prev
                })
              }}
            >
              <Search className="size-3.5" />
            </button>
            <button
              type="button"
              title="View settings"
              className={cn(
                'p-0.5 transition-colors',
                configOpen ? 'text-accent' : 'text-muted-foreground/60 hover:text-foreground',
              )}
              onClick={() => {
                haptic('tap')
                setConfigOpen(v => !v)
              }}
            >
              <Sliders className="size-3.5" />
            </button>
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground font-mono"
              onClick={() => refresh()}
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="px-3 pb-2 space-y-1.5">
          {/* Text search -- toggleable */}
          {searchOpen && (
            <div className="flex items-center gap-2">
              <input
                ref={searchRef}
                aria-label="Filter tasks by title"
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => haptic('tap')}
                placeholder="Filter by title..."
                className="flex-1 bg-surface-inset border border-border/70 px-2 py-1 text-xs font-mono text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent/50"
              />
              {hasActiveFilters && (
                <button
                  type="button"
                  className="text-[9px] text-muted-foreground/60 hover:text-foreground font-mono shrink-0"
                  onClick={clearFilters}
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {configOpen && <ViewConfigPanel view={view} update={updateView} reset={resetView} />}

          {/* Priority + tag filters -- always visible */}
          <div className="flex items-center gap-1">
            {(['high', 'medium', 'low'] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => togglePriority(p)}
                className={cn(
                  'px-1.5 py-0.5 text-[9px] font-mono border rounded transition-colors',
                  selectedPriority === p ? PRIORITY_COLORS[p] : CHIP_IDLE,
                )}
              >
                {p}
              </button>
            ))}
            <span className="w-px h-3 bg-border/30 mx-0.5" />
            {/* Tag pills */}
            <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0 scrollbar-none">
              {tagFreqs.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    'px-1.5 py-0.5 text-[9px] font-mono border rounded whitespace-nowrap shrink-0 transition-colors',
                    selectedTags.has(tag) ? tagColor(tag) : CHIP_IDLE,
                  )}
                >
                  {tag}
                  <span className="ml-0.5 opacity-50">{count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {view.mode === 'epics' && (
        <EpicsView tasks={filteredTasks} onOpenCard={openCardBySlug} onWorkOnEpic={handleWorkOnEpic} />
      )}

      {/* Kanban columns */}
      {view.mode === 'lanes' && (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
            <div className="flex gap-0 h-full min-w-max">
              {TASK_COLUMNS.map(col => {
                const colTasks = activeTasks.filter(n => n.status === col.status)
                return (
                  <DroppableColumn key={col.status} status={col.status} width={view.columnWidth}>
                    {/* Column header */}
                    <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2 shrink-0">
                      <span className={cn('text-[11px] font-bold font-mono uppercase tracking-wider', col.color)}>
                        {col.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground/75 font-mono">{colTasks.length}</span>
                    </div>

                    {/* Cards */}
                    <div className="flex-1 overflow-y-auto space-y-0 pb-4">
                      {colTasks.map(renderCard)}

                      {col.status === 'inbox' && <InlineAdd onAdd={handleCreate} />}
                    </div>
                  </DroppableColumn>
                )
              })}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {activeDragTask && (
              <div className="px-3 py-2 bg-surface-inset border border-primary/25 shadow-xl opacity-90 max-w-[250px]">
                <div className="text-xs font-mono text-foreground truncate">{activeDragTask.title}</div>
                {activeDragTask.bodyPreview && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                    {activeDragTask.bodyPreview}
                  </div>
                )}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {/* Archived section - collapsible */}
      {view.mode === 'lanes' && archivedTasks.length > 0 && (
        <div className="border-t border-border shrink-0">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            onClick={() => {
              haptic('tap')
              setArchiveExpanded(!archiveExpanded)
            }}
          >
            {archiveExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <Archive className="size-3" />
            <span className="text-[11px] font-mono uppercase tracking-wider">Archived</span>
            <span className="text-[10px] font-mono">{archivedTasks.length}</span>
          </button>
          {archiveExpanded && (
            <div className="max-h-[200px] overflow-y-auto border-t border-border/30">
              {archivedTasks.map(renderCard)}
            </div>
          )}
        </div>
      )}

      {/* Full-screen editor modal */}
      {editingTask && (
        <TaskEditor
          task={editingTask}
          conversationId={conversationId}
          onSave={async (id, patch) => {
            await updateTask(id, patch)
          }}
          onMove={async (id, to) => {
            const result = await moveTask(id, to)
            // The card's id and path are unchanged -- only its lane moved, so the
            // open editor just needs its status refreshed.
            if (result) setEditingTask(prev => (prev && prev.slug === id ? { ...prev, status: to } : prev))
            return !!result
          }}
          onRun={task => {
            setEditingTask(null)
            setRunTask(task)
          }}
          onPromote={task => {
            const uri = useConversationsStore.getState().conversationsById[conversationId]?.project
            if (!uri) return
            void enqueueNightshiftTask(uri, {
              title: task.title,
              description: task.body || undefined,
              source: 'board',
              boardRef: task.slug,
            })
            setEditingTask(null)
            haptic('success')
          }}
          onClose={() => setEditingTask(null)}
        />
      )}

      {/* Run task dialog (lifted out of TaskEditor so it persists after editor closes) */}
      {runTask && <RunTaskDialog task={runTask} conversationId={conversationId} onClose={() => setRunTask(null)} />}
    </div>
  )
})

export { RunTaskDialog } from './project-board/run-task-dialog'
// Split out 2026-08-14 (this file was 1766 LOC). Re-exported here because both
// are imported from '../project-board' by TaskEditorOverlay and by tests.
export { TaskEditor } from './project-board/task-editor'
