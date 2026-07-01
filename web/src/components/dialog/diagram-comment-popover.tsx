/**
 * DiagramCommentPopover -- the little input that pops on a clicked mermaid node.
 *
 * Portaled to body so the diagram block's `overflow-x-auto` can't clip it;
 * fixed-positioned at the node's viewport rect. One editable note per node:
 * type + Save (or Enter), Clear removes it, Esc / outside-click / Save closes.
 */

import { Check, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn, haptic } from '@/lib/utils'
import type { ActiveNode } from './use-diagram-comments'

export function DiagramCommentPopover({
  node,
  initialNote,
  onSave,
  onClose,
}: {
  node: ActiveNode
  initialNote: string
  onSave: (text: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState(initialNote)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Focus the field on open; re-seed when switching to a different node.
  useEffect(() => {
    setText(initialNote)
    inputRef.current?.focus()
  }, [node.nodeId])

  // Esc to close, outside-click to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    // Defer so the opening click doesn't immediately count as "outside".
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  function save() {
    haptic('tap')
    onSave(text)
    onClose()
  }

  // Anchor below the node, clamped into the viewport.
  const width = 256
  const left = Math.max(8, Math.min(node.rect.left, window.innerWidth - width - 8))
  const top = Math.min(node.rect.bottom + 6, window.innerHeight - 140)

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', left, top, width }}
      className={cn(
        'z-[110] flex flex-col gap-2 p-2.5 rounded-lg',
        'bg-background/95 backdrop-blur border border-border/60 shadow-xl',
      )}
    >
      <div className="text-[11px] font-mono text-muted-foreground truncate" title={node.label}>
        {node.label}
      </div>
      <textarea
        ref={inputRef}
        aria-label="Diagram node comment"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault()
            save()
          }
        }}
        placeholder="Add a note..."
        rows={2}
        className={cn(
          'w-full resize-y min-h-14 text-sm rounded border border-border/50 bg-background px-2 py-1.5',
          'placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50',
        )}
      />
      <div className="flex items-center justify-between gap-2">
        {initialNote ? (
          <button
            type="button"
            onClick={() => {
              haptic('tap')
              onSave('')
              onClose()
            }}
            className="flex items-center gap-1 text-xs text-destructive/80 hover:text-destructive px-1.5 py-1 rounded hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" /> Clear
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={save}
          className="flex items-center gap-1 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 px-2.5 py-1 rounded"
        >
          <Check className="size-3.5" /> Save
        </button>
      </div>
    </div>,
    document.body,
  )
}
