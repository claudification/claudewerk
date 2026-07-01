import { useEffect, useRef, useState } from 'react'
import type { ProjectOrderGroup } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { GroupContextMenu } from './workspace-assign-menu'

// ─── Group node (collapsible folder) ───────────────────────────────
// Read-only in the sidebar: collapse + double-click rename only. Structural
// edits (reorder, group membership) live in the Organize Projects modal.

export function GroupNode({
  group,
  idsByProject,
  collapsed,
  onToggle,
  onRename,
}: {
  group: ProjectOrderGroup
  idsByProject: Map<string, string[]>
  collapsed: boolean
  onToggle: () => void
  onRename: (newName: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  // Live-conversation count only rendered when collapsed -- skip the filter otherwise.
  const childCount = collapsed
    ? group.children.filter(c => {
        if (c.type === 'project') {
          return idsByProject.has(c.id)
        }
        return true
      }).length
    : 0

  return (
    <GroupContextMenu groupId={group.id}>
      {/* contains nested input/textbox; cannot be a native <button> */}
      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role */}
      <div
        role="button"
        tabIndex={0}
        className="text-[10px] font-bold uppercase tracking-wider p-1 mb-1 flex items-center gap-1.5 cursor-pointer select-none text-primary/60"
        onClick={() => {
          haptic('tick')
          onToggle()
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            haptic('tick')
            onToggle()
          }
        }}
      >
        <span>{collapsed ? '\u25B8' : '\u25BE'}</span>
        {editing ? (
          <input
            ref={inputRef}
            aria-label="Rename group"
            type="text"
            defaultValue={group.name}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            className="bg-transparent border-b border-primary text-primary text-[10px] font-bold uppercase outline-none flex-1"
            onBlur={e => {
              const v = e.currentTarget.value.trim()
              if (v && v !== group.name) onRename(v)
              setEditing(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim()
                if (v && v !== group.name) onRename(v)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          // double-click-to-edit affordance; not a real text input until <input> renders
          // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
          <span
            role="textbox"
            tabIndex={0}
            onDoubleClick={e => {
              e.stopPropagation()
              setEditing(true)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.stopPropagation()
                setEditing(true)
              }
            }}
          >
            {group.name}
          </span>
        )}
        {collapsed && <span className="text-muted-foreground/40 font-normal normal-case">({childCount})</span>}
        <span className="flex-1 h-px bg-border/50" />
      </div>
    </GroupContextMenu>
  )
}
