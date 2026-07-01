import { useRef, useState } from 'react'
import { useDispatchStore } from './dispatch-store'

/** Modal editor for /memory (bare) and /system -- a textarea with save/cancel.
 *  CM6 integration deferred; a styled textarea is the MVP. */
export function MemoryEditorModal() {
  const modal = useDispatchStore(s => s.editorModal)
  const saveEditor = useDispatchStore(s => s.saveEditor)
  const closeEditor = useDispatchStore(s => s.closeEditor)
  const [draft, setDraft] = useState('')
  const initialized = useRef(false)

  if (!modal) return null
  if (!initialized.current || draft === '') {
    if (!initialized.current) {
      setDraft(modal.content)
      initialized.current = true
    }
  }

  const title = modal.kind === 'memory' ? 'Dispatcher Memory' : 'Appended System Prompt'
  const hint =
    modal.kind === 'memory'
      ? 'Durable facts the dispatcher remembers. Edit freely; versions are backed up.'
      : 'Standing instructions appended after the hard system prompt every turn.'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="mx-4 flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border bg-background p-5 shadow-2xl">
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="mt-1 text-[11px] text-comment">{hint}</p>
        </div>
        <textarea
          aria-label="Dispatch memory editor"
          className="min-h-[300px] w-full resize-y rounded-lg border border-border/70 bg-card/40 p-3 font-mono text-[12px] leading-relaxed text-foreground focus:border-accent focus:outline-none"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: modal editor should focus immediately
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-4 py-1.5 text-[12px] text-comment hover:bg-card"
            onClick={() => {
              initialized.current = false
              closeEditor()
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-1.5 text-[12px] text-white hover:bg-accent/80"
            onClick={() => {
              saveEditor(draft)
              initialized.current = false
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/** Diff preview for /memory x refinement -- shows before/after with confirm/cancel. */
export function RefinePreviewModal() {
  const preview = useDispatchStore(s => s.refinePreview)
  const confirmRefine = useDispatchStore(s => s.confirmRefine)
  const cancelRefine = useDispatchStore(s => s.cancelRefine)

  if (!preview) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="mx-4 flex w-full max-w-3xl flex-col gap-3 rounded-xl border border-border bg-background p-5 shadow-2xl">
        <div>
          <h3 className="text-sm font-medium text-foreground">Memory Refinement Preview</h3>
          <p className="mt-1 text-[11px] text-comment">
            Refined by {preview.model}. Review the changes and confirm or cancel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="mb-1 block text-[10px] uppercase tracking-[0.2em] text-comment">Before</span>
            <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-card/40 p-3 font-mono text-[11px] leading-relaxed text-comment">
              {preview.before || '(empty)'}
            </pre>
          </div>
          <div>
            <span className="mb-1 block text-[10px] uppercase tracking-[0.2em] text-accent">After</span>
            <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-lg border border-accent/30 bg-accent/5 p-3 font-mono text-[11px] leading-relaxed text-foreground">
              {preview.after || '(empty)'}
            </pre>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-4 py-1.5 text-[12px] text-comment hover:bg-card"
            onClick={cancelRefine}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-1.5 text-[12px] text-white hover:bg-accent/80"
            onClick={confirmRefine}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
