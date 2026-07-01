/**
 * Completed-items archive (lazy). Lists a project's done items grouped by
 * resolution date (newest first), with a text filter and a "delete completed
 * >30d" bulk purge. Re-opening an item (undo) sends it back to the active list.
 */

import type { ChecklistItem } from '@shared/protocol'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { fetchChecklistArchive, purgeChecklistArchive, setChecklistStatus } from '@/lib/checklist-client'
import { groupByResolvedDate } from '@/lib/checklist-dategroup'
import { Markdown } from '../markdown'
import { type ChecklistModalDetail, checklistArchiveBus } from './checklist-bus'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export function ChecklistArchiveModal() {
  const [open, setOpen] = useState(false)
  const project = useRef('')
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('') // react-doctor-disable-line react-doctor/no-derived-state -- user-controlled input, not derived

  const reload = useCallback(async (proj: string) => {
    setLoading(true)
    try {
      setItems(await fetchChecklistArchive(proj))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    function onOpen(detail: ChecklistModalDetail) {
      project.current = detail.project
      setFilter('')
      setOpen(true)
      void reload(detail.project)
    }
    checklistArchiveBus.setHandler(onOpen)
    return () => checklistArchiveBus.setHandler(null)
  }, [reload])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = q ? items.filter(i => i.text.toLowerCase().includes(q)) : items
    return groupByResolvedDate(matched, Date.now())
  }, [items, filter])

  const reopen = (id: string) => {
    setChecklistStatus(project.current, id, 'open')
    setItems(prev => prev.filter(i => i.id !== id))
  }

  const purgeOld = async () => {
    await purgeChecklistArchive(project.current, THIRTY_DAYS_MS)
    void reload(project.current)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={o => !o && setOpen(false)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(640px,95vw)] max-h-[80vh] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover shadow-lg flex flex-col">
          <div className="px-4 pt-4 pb-2 border-b border-border flex items-center justify-between gap-3 shrink-0">
            <DialogPrimitive.Title className="text-sm font-semibold shrink-0">Completed</DialogPrimitive.Title>
            <input
              value={filter}
              onChange={e => setFilter(e.currentTarget.value)}
              aria-label="Filter completed"
              placeholder="Filter…"
              className="flex-1 min-w-0 bg-muted/30 border border-border/60 rounded px-2 py-1 text-xs outline-none focus:border-accent/60"
            />
            <button
              type="button"
              onClick={purgeOld}
              title="Delete completed items older than 30 days"
              className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
            >
              <Trash2 className="size-3" /> &gt;30d
            </button>
            <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground p-1 shrink-0">
              ✕
            </DialogPrimitive.Close>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>}
            {!loading && groups.length === 0 && (
              <div className="px-3 py-6 text-xs text-muted-foreground text-center">Nothing completed yet.</div>
            )}
            {groups.map(g => (
              <div key={g.label} className="mb-2">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/50">{g.label}</div>
                {g.items.map(i => (
                  <div key={i.id} className="group/ar flex items-center gap-2 px-2 py-0.5 text-xs">
                    <span className="flex-1 min-w-0 truncate text-muted-foreground line-through [&_p]:inline">
                      <Markdown inline>{i.text}</Markdown>
                    </span>
                    <button
                      type="button"
                      title="Re-open"
                      onClick={() => reopen(i.id)}
                      className="shrink-0 text-muted-foreground/50 hover:text-foreground opacity-0 group-hover/ar:opacity-100 transition-opacity"
                    >
                      <RotateCcw className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex justify-end shrink-0">
            <Kbd>Esc</Kbd>
            <span className="ml-1">to close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
