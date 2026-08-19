import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { FolderPlus } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { GroupRow, ProjectRow, UngroupedDropZone } from './organize-rows'
import { closeOrganizeProjects, useOrganizeProjectsOpen } from './organize-state'
import { useOrganizeDraft } from './use-organize-draft'

function OrganizeModalInner() {
  const d = useOrganizeDraft()
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  const groups = d.tree.filter(n => n.type === 'group')
  const sortableIds = [
    ...groups.flatMap(g => (g.type === 'group' ? [g.id, ...g.children.map(c => c.id)] : [])),
    ...d.pool,
  ]

  function onDragEnd(e: DragEndEvent) {
    d.applyDrag(String(e.active.id), e.over ? String(e.over.id) : null)
  }

  function done() {
    d.save()
    closeOrganizeProjects()
  }

  return (
    <DialogContent className="max-w-md max-h-[80vh] p-0">
      <div className="flex flex-col max-h-[80vh]">
        <div className="px-4 pt-4 pb-2 shrink-0">
          <DialogTitle>Organize projects</DialogTitle>
          <p className="text-[11px] text-muted-foreground mt-1">
            Drag the grips to reorder groups and move projects between them. Nothing changes until you save.
          </p>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
              {groups.map(g =>
                g.type === 'group' ? (
                  <GroupRow
                    key={g.id}
                    group={g}
                    count={g.children.reduce((n, c) => n + d.countOf(c.id), 0)}
                    onRename={name => d.renameGroup(g.id, name)}
                    onDelete={() => d.deleteGroup(g.id)}
                  >
                    {g.children.length === 0 ? (
                      <p className="text-[10px] text-fg-dim px-1 py-0.5">Drop projects here</p>
                    ) : (
                      g.children.map(c => (
                        <ProjectRow
                          key={c.id}
                          id={c.id}
                          label={d.labelOf(c.id)}
                          count={d.countOf(c.id)}
                          onUngroup={() => d.ungroup(c.id)}
                        />
                      ))
                    )}
                  </GroupRow>
                ) : null,
              )}

              <button
                type="button"
                onClick={d.addGroup}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground px-1 py-1"
              >
                <FolderPlus className="size-3.5" /> New group
              </button>

              <div className="text-[10px] text-fg-dim font-bold uppercase tracking-wider px-1 pt-1">Ungrouped</div>
              <UngroupedDropZone>
                {d.pool.length === 0 ? (
                  <p className="text-[10px] text-fg-dim px-1 py-0.5">Everything is grouped.</p>
                ) : (
                  d.pool.map(uri => <ProjectRow key={uri} id={uri} label={d.labelOf(uri)} count={d.countOf(uri)} />)
                )}
              </UngroupedDropZone>
            </div>
          </SortableContext>
        </DndContext>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            type="button"
            onClick={closeOrganizeProjects}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={done}
            disabled={!d.dirty}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground font-medium disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </DialogContent>
  )
}

export function OrganizeProjectsModal() {
  const open = useOrganizeProjectsOpen()
  return (
    <Dialog open={open} onOpenChange={o => !o && closeOrganizeProjects()}>
      {/* Remount per open so the draft re-seeds from live state. */}
      {open && <OrganizeModalInner />}
    </Dialog>
  )
}
