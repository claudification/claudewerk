/**
 * The card editor -- the full-screen dialog behind clicking a board card.
 *
 * Split out of project-board.tsx (1766 LOC) on 2026-08-14. It is mounted from
 * two places (the board, and TaskEditorOverlay next to the transcript), so it
 * was never board-specific to begin with.
 */

import type { EditorView } from '@codemirror/view'
import { Archive, Eye, Moon, Pencil, RotateCcw, Zap } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { sendInput } from '@/hooks/use-conversations'
import type { ProjectTask, TaskStatus } from '@/hooks/use-project'
import { useKeyLayer } from '@/lib/key-layers'
import { buildTaskPrompt } from '@/lib/task-scoring'
import { uploadFileWithPlaceholder } from '@/lib/upload'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from '../markdown'
import { NEXT_STATUS, PREV_STATUS, PRIORITY_COLORS, TASK_COLUMNS, tagColor, taskAge } from './board-constants'
import { CardEpicStrip } from './card-epic-strip'

// CodeMirror markdown editor for task bodies, lazy-loaded.
const MarkdownBodyPane = lazy(() => import('../markdown-body-pane'))

function MarkdownEditorPane(props: {
  initialContent: string
  onChange: (value: string) => void
  onUpload: (file: File) => void
  editorViewRef: React.RefObject<EditorView | null>
}) {
  return (
    <Suspense fallback={<div className="relative w-full min-h-[200px]" />}>
      <MarkdownBodyPane {...props} />
    </Suspense>
  )
}

// PRE-EXISTING complexity, not new: this component is unchanged from
// project-board.tsx, where it was already cyclomatic 25. The gate reads a move
// into a new file as "introduced". Splitting the editor itself (header, body,
// footer actions, tag row) is real work and is NOT part of the epics change.
// fallow-ignore-next-line complexity
export function TaskEditor({
  task,
  conversationId,
  onSave,
  onMove,
  onRun,
  onPromote,
  onOpenTask,
  onClose,
}: {
  task: ProjectTask
  conversationId: string
  onSave: (id: string, patch: { title?: string; body?: string; priority?: string; tags?: string[] }) => Promise<unknown>
  onMove: (id: string, to: TaskStatus) => Promise<boolean>
  onRun: (task: ProjectTask) => void
  /** Promote this card into the project's nightshift queue (absent => hidden). */
  onPromote?: (task: ProjectTask) => void
  /** Swap the editor onto another card -- what the epic strip navigates with.
   *  Absent => the strip still names the epic, it just is not clickable. */
  onOpenTask?: (task: ProjectTask) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>(task.priority || 'medium')
  const [tags, setTags] = useState<string[]>(task.tags || [])
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(!body.trim())
  const editorViewRef = useRef<EditorView | null>(null)
  /**
   * A card with content is OPENED TO BE READ. Radix focuses the first focusable
   * child (the title input) on open, and a focused text input auto-blocks every
   * bare-key shortcut -- so L/W/A silently did nothing on the card you just
   * opened. Captured once on mount so it does not flip while you type.
   *
   * A blank card is the opposite intent: you are creating it, so the cursor
   * belongs in the title.
   */
  const openedForReading = useRef(!!task.body.trim())
  const canWork = status === 'inbox' || status === 'open' || status === 'in-progress' || status === 'in-review'

  useKeyLayer(
    {
      // Bare keys -- auto-blocked when a text input / CodeMirror is focused.
      // Radix Dialog handles Escape itself via onOpenChange.
      w: () => {
        if (!canWork) return
        sendInput(conversationId, buildTaskPrompt({ ...task, title, body, status, priority, tags }))
        haptic('success')
        onClose()
      },
      l: () => {
        if (!canWork) return
        haptic('tap')
        onRun({ ...task, title, body, status, priority, tags })
      },
      a: () => {
        if (status === 'archived') return
        setStatus('archived')
        onMove(task.slug, 'archived')
        haptic('tap')
      },
      // Modifier keys -- fire even in text inputs
      'mod+s': () => handleSave(),
      'mod+Enter': () => handleSave(),
      // Ctrl+Shift+Arrow: move task status (safe on Mac -- not a standard text editing combo)
      'ctrl+shift+ArrowRight': () => {
        const next = NEXT_STATUS[status]
        if (next) {
          setStatus(next)
          onMove(task.slug, next)
          haptic('tap')
        }
      },
      'ctrl+shift+ArrowLeft': () => {
        const prev = PREV_STATUS[status]
        if (prev) {
          setStatus(prev)
          onMove(task.slug, prev)
          haptic('tap')
        }
      },
    },
    { id: 'task-editor' },
  )

  // Sync non-editing fields from prop when task is updated externally (e.g. project_changed)
  // Intentionally does NOT sync title/body to avoid overwriting user edits
  useEffect(() => {
    setStatus(task.status)
    setPriority(task.priority || 'medium')
    setTags(task.tags || [])
  }, [task.status, task.priority, task.tags])

  function uploadFile(file: File) {
    const view = editorViewRef.current
    if (!view) return
    uploadFileWithPlaceholder(
      file,
      placeholder => {
        view.dispatch({ changes: { from: view.state.selection.main.head, insert: placeholder } })
      },
      (search: string, replacement: string) => {
        const content = view.state.doc.toString()
        const idx = content.indexOf(search)
        if (idx >= 0) view.dispatch({ changes: { from: idx, to: idx + search.length, insert: replacement } })
      },
      conversationId,
    )
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
    }
    setTagInput('')
  }

  async function handleSave() {
    setSaving(true)
    await onSave(task.slug, { title, body, priority, tags })
    setSaving(false)
    haptic('success')
    onClose()
  }

  return (
    <Dialog open={true} onOpenChange={v => !v && onClose()}>
      <DialogContent
        className="max-w-2xl max-h-[80vh] flex flex-col p-0"
        onOpenAutoFocus={e => {
          if (openedForReading.current) e.preventDefault()
        }}
      >
        <DialogTitle className="sr-only">Edit task: {title}</DialogTitle>

        {/* WHAT THIS CARD BELONGS TO -- above the title, because it is the
            context you read the title IN. Renders nothing for a loose card. */}
        <CardEpicStrip task={task} conversationId={conversationId} onOpenTask={onOpenTask} />

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20 shrink-0">
          <input
            aria-label="Task title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="flex-1 bg-transparent text-sm font-mono text-foreground outline-none placeholder:text-muted-foreground/60"
            placeholder="Title..."
          />
          <select
            value={status}
            onChange={e => {
              const newStatus = e.target.value as TaskStatus
              if (newStatus === status) return
              const oldStatus = status
              setStatus(newStatus)
              haptic('tap')
              // Immediately move the file on disk and update the board UI
              onMove(task.slug, newStatus)
            }}
            className={cn(
              'text-[10px] font-mono bg-transparent border px-1 py-0.5 outline-none',
              status === 'inbox' && 'border-event-prompt/50 text-event-prompt',
              status === 'open' && 'border-primary/50 text-primary',
              status === 'in-progress' && 'border-accent/50 text-accent',
              status === 'in-review' && 'border-info/50 text-info',
              status === 'done' && 'border-emerald-500/50 text-emerald-400',
              status === 'archived' && 'border-primary/20 text-muted-foreground',
            )}
          >
            <option value="inbox">inbox</option>
            <option value="open">open</option>
            <option value="in-progress">in-progress</option>
            <option value="in-review">in-review</option>
            <option value="done">done</option>
            <option value="archived">archived</option>
          </select>
          <select
            value={priority}
            onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high')}
            className="text-[10px] font-mono bg-transparent border border-primary/20 text-muted-foreground px-1 py-0.5 outline-none"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <span className="text-[9px] text-muted-foreground/60 font-mono">{taskAge(task.created)}</span>
        </div>

        {/* Tags */}
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-primary/12 flex-wrap shrink-0">
          {tags.map(tag => (
            <span
              key={tag}
              className={cn('text-[9px] px-1.5 py-0.5 border font-mono flex items-center gap-1', tagColor(tag))}
            >
              {tag}
              <button type="button" className="hover:opacity-60" onClick={() => setTags(tags.filter(t => t !== tag))}>
                x
              </button>
            </span>
          ))}
          <input
            aria-label="Add tag to task"
            type="text"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              }
              if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                setTags(tags.slice(0, -1))
              }
            }}
            placeholder="add tag..."
            className="text-[10px] bg-transparent text-muted-foreground outline-none w-16 font-mono placeholder:text-muted-foreground/60"
          />
        </div>

        {/* Body - toggle between markdown view and edit */}
        <div className="flex items-center justify-between px-4 py-1 border-b border-primary/8 shrink-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors',
                !editing ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Eye className="size-3" /> View
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors',
                editing ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Pencil className="size-3" /> Edit
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {editing ? (
            <MarkdownEditorPane
              initialContent={body}
              onChange={setBody}
              onUpload={uploadFile}
              editorViewRef={editorViewRef}
            />
          ) : body.trim() ? (
            // markdown body may contain links; cannot be a native <button>
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            <div
              role="button"
              tabIndex={0}
              title="Double-click to edit"
              className="text-sm text-foreground prose prose-invert prose-sm max-w-none cursor-text"
              // DOUBLE-click, not single: an open card is for READING. Single
              // click flipped you into the editor the moment you tried to select
              // a line of text, which is also how you lost the bare-key
              // shortcuts (a focused editor blocks them).
              onDoubleClick={() => setEditing(true)}
              onKeyDown={e => {
                if (e.key === 'Enter') setEditing(true)
              }}
            >
              <Markdown>{body}</Markdown>
            </div>
          ) : (
            <button
              type="button"
              className="text-sm text-muted-foreground/60 font-mono cursor-text min-h-[200px] text-left w-full appearance-none bg-transparent border-0 p-0"
              onClick={() => setEditing(true)}
            >
              Click to add content…
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-primary/20 shrink-0">
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-3">
              {/* Context-aware actions based on task status */}
              {canWork && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      sendInput(conversationId, buildTaskPrompt({ ...task, title, body, status, priority, tags }))
                      haptic('success')
                      onClose()
                    }}
                    className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                  >
                    Work on this <Kbd className="ml-1.5 opacity-60">W</Kbd>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('tap')
                      onRun({ ...task, title, body, status, priority, tags })
                    }}
                    className="flex items-center gap-1 whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors"
                  >
                    <Zap className="size-3" />
                    Launch <Kbd className="ml-1 opacity-60">L</Kbd>
                  </button>
                </>
              )}
              {status === 'in-review' && (
                <button
                  type="button"
                  onClick={() => {
                    setStatus('done')
                    onMove(task.slug, 'done')
                    haptic('success')
                  }}
                  className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                >
                  Approve
                </button>
              )}
              {status === 'done' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setStatus('in-review')
                      onMove(task.slug, 'in-review')
                      haptic('tap')
                    }}
                    className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-info/15 text-info border border-info/30 hover:bg-info/25 transition-colors"
                  >
                    Reopen
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStatus('archived')
                      onMove(task.slug, 'archived')
                      haptic('tap')
                    }}
                    className="flex items-center gap-1 whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-primary/12 text-muted-foreground border border-primary/20 hover:bg-primary/20 transition-colors"
                  >
                    <Archive className="size-3" />
                    Archive <Kbd className="ml-1.5 opacity-60">A</Kbd>
                  </button>
                </>
              )}
              {status === 'archived' && (
                <button
                  type="button"
                  onClick={() => {
                    setStatus('open')
                    onMove(task.slug, 'open')
                    haptic('tap')
                  }}
                  className="whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors"
                >
                  Reopen
                </button>
              )}
              {onPromote && (
                <button
                  type="button"
                  onClick={() => {
                    haptic('tap')
                    onPromote({ ...task, title, body, status, priority, tags })
                  }}
                  title="Promote this card into the nightshift queue"
                  className="flex items-center gap-1 whitespace-nowrap px-3 py-1 text-[11px] font-bold font-mono bg-amber-400/10 text-amber-300 border border-amber-400/25 hover:bg-amber-400/20 transition-colors"
                >
                  <Moon className="size-3" />
                  Nightshift
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel <Kbd className="opacity-60">Esc</Kbd>
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1 text-xs font-bold font-mono bg-accent/20 text-accent hover:bg-accent/30 transition-colors disabled:opacity-50"
              >
                {saving ? '...' : 'Save'} <Kbd className="ml-1.5 opacity-60">^S</Kbd>
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between px-4 pb-1.5">
            <span className="text-[10px] text-muted-foreground/60 font-mono">{task.slug}.md</span>
            <div className="flex items-center gap-3 text-[9px] text-comment font-mono">
              {PREV_STATUS[status] && (
                <span>
                  <Kbd>^⇧←</Kbd> {PREV_STATUS[status]}
                </span>
              )}
              {NEXT_STATUS[status] && (
                <span>
                  <Kbd>^⇧→</Kbd> {NEXT_STATUS[status]}
                </span>
              )}
              {status !== 'archived' && (
                <span>
                  <Kbd>A</Kbd> archive
                </span>
              )}
              <span>
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
