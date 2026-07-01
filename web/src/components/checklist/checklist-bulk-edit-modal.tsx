/**
 * Bulk markdown editor (lazy). Presents the WHOLE list (active + completed) as a
 * markdown task document in CodeMirror -- the user edits freely (reorder, retext,
 * change `[ ]`/`[~]`/`[x]`, delete) and Save re-parses the doc and replaces the
 * stored state. Completion dates ride in trailing parens so the archive keeps
 * them; missing dates are best-effort. CodeMirror travels with this lazy chunk.
 */

import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { SafeCodeMirror } from '@/components/codemirror/safe-codemirror'
import { Kbd } from '@/components/ui/kbd'
import { fetchChecklistArchive, fetchChecklistOpen, replaceChecklist } from '@/lib/checklist-client'
import { itemsToMarkdown, markdownToItems } from '@/lib/checklist-markdown'
import { type ChecklistModalDetail, checklistBulkEditBus } from './checklist-bus'

// Markdown highlighting + soft wrap. Travels with this lazy chunk (LAZY LOAD).
const CM_EXTENSIONS = [markdown(), EditorView.lineWrapping]

export function ChecklistBulkEditModal() {
  const [open, setOpen] = useState(false)
  const project = useRef('')
  const [doc, setDoc] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    async function onOpen(detail: ChecklistModalDetail) {
      project.current = detail.project
      setOpen(true)
      setLoading(true)
      try {
        const [active, done] = await Promise.all([
          fetchChecklistOpen(detail.project),
          fetchChecklistArchive(detail.project),
        ])
        setDoc(itemsToMarkdown(active, done))
      } finally {
        setLoading(false)
      }
    }
    checklistBulkEditBus.setHandler(onOpen)
    return () => checklistBulkEditBus.setHandler(null)
  }, [])

  const save = async () => {
    await replaceChecklist(project.current, markdownToItems(doc))
    setOpen(false)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={o => !o && setOpen(false)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(1000px,96vw)] h-[88vh] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover shadow-lg flex flex-col">
          <div className="px-4 pt-4 pb-2 border-b border-border flex items-center justify-between shrink-0">
            <div>
              <DialogPrimitive.Title className="text-sm font-semibold">Edit checklist</DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-[11px] text-muted-foreground mt-0.5">
                <code>- [ ]</code> open · <code>- [~]</code> in progress · <code>- [x]</code> done · save replaces the
                list
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground p-1">✕</DialogPrimitive.Close>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-2 text-xs">
            {loading ? (
              <div className="px-3 py-2 text-muted-foreground">Loading…</div>
            ) : (
              <SafeCodeMirror
                autoFocus
                value={doc}
                onChange={setDoc}
                extensions={CM_EXTENSIONS}
                theme="dark"
                height="100%"
                basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
                className="text-[13px] h-full"
              />
            )}
          </div>

          <div className="px-4 py-2 border-t border-border flex items-center justify-between shrink-0">
            <span className="text-[10px] text-muted-foreground flex items-center">
              <Kbd>Esc</Kbd>
              <span className="ml-1">to cancel</span>
            </span>
            <button
              type="button"
              onClick={save}
              className="px-3 py-1 rounded bg-accent/80 hover:bg-accent text-accent-foreground text-xs font-medium"
            >
              Save
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
