import { cn } from '@/lib/utils'
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

/**
 * The one thing you do: tell the concierge what you need, in your own words.
 *
 * ISOLATION DIAGNOSTIC (2026-06-26): the CM6 `InputEditor` is temporarily ripped out
 * and replaced with a dumb native <textarea> wired straight to intent/setIntent/submit.
 * Native onChange is bulletproof, so this proves whether the dead-input bug lives in
 * the CM6 backend (input works now -> CM6 was it) or downstream in submit/store/wire
 * (still dead -> not the widget). A live readout under the box shows intent + state.
 */
export function DispatchIntentInput() {
  const intent = useDispatchStore(s => s.intent)
  const pending = useDispatchStore(s => s.pending)
  const lastError = useDispatchStore(s => s.lastError)
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
        <textarea
          value={intent}
          onChange={e => setIntent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="tell me in your own words…"
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the cockpit's single purpose is this box
          autoFocus
          className="min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-relaxed text-foreground placeholder:text-comment/50 focus-visible:outline-none"
        />
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
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
        <ModelSelect />
        {/* Temporary isolation readout -- remove with the CM6 swap. */}
        <span className="font-mono text-[10px] text-comment/50">
          intent:{intent.length} {pending ? '· sending…' : ''} {lastError ? `· err: ${lastError.slice(0, 40)}` : ''}
        </span>
      </div>
    </div>
  )
}
