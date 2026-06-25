import { cn } from '@/lib/utils'
import { InputEditor } from '../input-editor'
import { DISPATCH_MODELS } from './dispatch-models'
import { useDispatchStore } from './dispatch-store'

/** Which model drives the dispatcher agent loop -- switchable per the user. */
function ModelSelect() {
  const model = useDispatchStore(s => s.model)
  const setModel = useDispatchStore(s => s.setModel)
  return (
    <select
      value={model}
      onChange={e => setModel(e.target.value)}
      aria-label="Dispatcher model"
      className="rounded-lg bg-transparent px-1 py-0.5 font-mono text-[11px] text-comment/70 focus-visible:outline-none"
    >
      {DISPATCH_MODELS.map(m => (
        <option key={m.slug} value={m.slug}>
          {m.label}
        </option>
      ))}
    </select>
  )
}

/** The one thing you do: tell the concierge what you need, in your own words.
 *  Pinned at the bottom of the desk. Reuses the SAME InputEditor as the main
 *  transcript (Slice E) -- so keybindings, sizing, and PASTE-TO-UPLOAD (an image/
 *  file paste lands as a `![](url)` markdown ref via the CM6 backend) all match.
 *  ⌘↵ / ↵ sends; the CM6 chunk is lazy-loaded only when that backend is enabled.
 *
 *  DEAD-INPUT FIX (2026-06-26): the CM6 backend used to no-op here because
 *  `submitFromEditor` cleared the doc BEFORE calling onSubmit, and the clear's
 *  synchronous onChange('') wiped the store's `intent` before `submit()` could
 *  read it. The main chat dodged it via a stale React closure; this desk reads
 *  the live zustand store, so it died. Fixed by submitting before clearing (see
 *  input-editor/backends/codemirror/extensions.ts + submit-from-editor.test.ts).
 */
export function DispatchIntentInput() {
  const intent = useDispatchStore(s => s.intent)
  const pending = useDispatchStore(s => s.pending)
  const setIntent = useDispatchStore(s => s.setIntent)
  const submit = useDispatchStore(s => s.submit)

  return (
    <div className="flex-none border-t border-border/60 px-5 py-4">
      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border bg-[var(--surface-inset)] px-3 py-2 transition-colors',
          pending
            ? 'border-[color-mix(in_oklch,var(--accent)_40%,transparent)]'
            : 'border-border focus-within:border-[color-mix(in_oklch,var(--accent)_45%,transparent)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <InputEditor
            value={intent}
            onChange={setIntent}
            onSubmit={() => submit()}
            placeholder="tell me in your own words…"
            autoFocus
            inline
          />
        </div>
        <button
          type="button"
          onClick={() => submit()}
          disabled={pending || !intent.trim()}
          aria-label="Send"
          className={cn(
            'mb-0.5 flex-none rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pending || !intent.trim() ? 'cursor-not-allowed bg-muted text-comment' : 'text-[var(--background)]',
          )}
          style={pending || !intent.trim() ? undefined : { background: 'var(--accent)' }}
        >
          ask
        </button>
      </div>
      <div className="mt-1.5 flex items-center px-1">
        <ModelSelect />
      </div>
    </div>
  )
}
