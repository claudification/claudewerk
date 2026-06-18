/**
 * Inline per-project checklist, pinned in the conversation list between a
 * project's header and its conversations. Shows the active items (open +
 * in_progress), a quick-add field (one line -> one item, multi-line paste ->
 * one per line with markdown-task parsing), and links to the completed archive
 * + the bulk markdown editor. Lives on the eager hot path, so it stays light.
 *
 * Empty state: with no open items the whole block stays hidden until the
 * project HEADER is hovered (so an empty project -- including one with no active
 * conversations -- shows no editor at rest, only a reveal-on-hover affordance).
 * On touch devices (no `hover:hover`) it stays visible, since there is no hover
 * to reveal it. The project node wraps the header + this block in a
 * `group/projhead` marker -- scoped to the header, NOT the whole card, so
 * hovering a conversation row does not pop the empty block open.
 */

import { ListChecks, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { useChecklist } from '@/hooks/use-checklist'
import { addChecklistItems } from '@/lib/checklist-client'
import { openChecklistArchive, openChecklistBulkEdit } from './checklist-bus'
import { ChecklistRow } from './checklist-row'

export function ProjectChecklist({ project }: { project: string }) {
  const { open } = useChecklist(project)
  const [text, setText] = useState('')
  const hasItems = open.length > 0

  const add = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    addChecklistItems(project, value)
    setText('')
  }

  const addField = (
    <div className="flex items-center gap-1.5 pl-3 pr-2 py-0.5">
      <Plus className="size-3.5 shrink-0 text-muted-foreground/50" />
      <input
        value={text}
        onChange={e => setText(e.currentTarget.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') add(text)
          else if (e.key === 'Escape') setText('')
        }}
        onPaste={e => {
          const pasted = e.clipboardData.getData('text')
          if (pasted.includes('\n')) {
            e.preventDefault()
            add(`${text}${pasted}`)
          }
        }}
        placeholder="Add a note..."
        className="flex-1 min-w-0 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground/40"
      />
    </div>
  )

  const footer = (
    <div className="flex items-center gap-3 pl-3 pr-2 pt-0.5 text-[10px] text-muted-foreground/50">
      <button
        type="button"
        onClick={() => openChecklistBulkEdit(project)}
        className="flex items-center gap-1 hover:text-foreground transition-colors"
        title="Edit the whole list as markdown"
      >
        <Pencil className="size-2.5" /> edit all
      </button>
      <button
        type="button"
        onClick={() => openChecklistArchive(project)}
        className="flex items-center gap-1 hover:text-foreground transition-colors"
        title="View completed items"
      >
        <ListChecks className="size-2.5" /> completed
      </button>
    </div>
  )

  // Empty: collapsed at rest on hover-capable devices, sliding open only while
  // the project node is hovered. No notes + no hover = nothing shown. Touch
  // devices (no hover:hover) skip the clamp and keep it visible.
  if (!hasItems) {
    return (
      <div className="overflow-hidden transition-[max-height] duration-150 [@media(hover:hover)]:max-h-0 [@media(hover:hover)]:group-hover/projhead:max-h-16">
        <div className="border-t border-border/40 bg-muted/10 py-1">
          {addField}
          {footer}
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-border/40 bg-muted/10 py-1">
      {open.map(item => (
        <ChecklistRow key={item.id} project={project} item={item} />
      ))}
      {addField}
      {footer}
    </div>
  )
}
