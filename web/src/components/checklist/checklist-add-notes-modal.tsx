/**
 * Add-notes modal (lazy). A multiline box for dumping several checklist items at
 * once for a project -- one item per line, markdown task syntax parsed
 * (`- [ ]` / `- [~]` / `- [x]`). Cmd/Ctrl+Enter (or Add) submits; Esc cancels.
 */

import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { addChecklistItems } from '@/lib/checklist-client'
import { parseChecklistInput } from '@/lib/checklist-parse'
import { type ChecklistModalDetail, checklistAddNotesBus } from './checklist-bus'

function projectLabel(uri: string): string {
  return uri.split('/').filter(Boolean).pop() || uri
}

function isSubmitKey(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey)
}

export function ChecklistAddNotesModal() {
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState('')
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    function onOpen(detail: ChecklistModalDetail) {
      setProject(detail.project)
      setText('')
      setOpen(true)
      setTimeout(() => ref.current?.focus(), 0)
    }
    checklistAddNotesBus.setHandler(onOpen)
    return () => checklistAddNotesBus.setHandler(null)
  }, [])

  const count = parseChecklistInput(text).length
  const suffix = count > 0 ? ` ${count}` : ''

  const submit = () => {
    if (count > 0) addChecklistItems(project, text)
    setOpen(false)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={o => !o && setOpen(false)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,95vw)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover shadow-lg flex flex-col">
          <div className="px-4 pt-4 pb-2 border-b border-border shrink-0">
            <DialogPrimitive.Title className="text-sm font-semibold">
              Add notes · {projectLabel(project)}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-[11px] text-muted-foreground mt-0.5">
              One per line. <code>- [ ]</code> open · <code>- [~]</code> in progress · <code>- [x]</code> done
            </DialogPrimitive.Description>
          </div>
          <div className="p-2">
            <textarea
              ref={ref}
              value={text}
              aria-label="Checklist notes"
              onChange={e => setText(e.currentTarget.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setOpen(false)
                else if (isSubmitKey(e)) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={'check Caddy upstream\n- [ ] reply to Danielle\n- [x] shipped the thing'}
              className="w-full h-44 resize-none bg-muted/20 border border-border/60 rounded p-2 text-xs text-foreground outline-none focus:border-accent/60 placeholder:text-muted-foreground/40"
            />
          </div>
          <div className="px-4 py-2 border-t border-border flex items-center justify-between shrink-0">
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Kbd>⌘</Kbd>
              <Kbd>⏎</Kbd>
              <span>to add{suffix}</span>
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={count === 0}
              className="px-3 py-1 rounded bg-accent/80 hover:bg-accent text-accent-foreground text-xs font-medium disabled:opacity-40"
            >
              Add{suffix}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
