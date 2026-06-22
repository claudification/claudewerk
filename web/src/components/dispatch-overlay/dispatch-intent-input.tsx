import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { useDispatchStore } from './dispatch-store'

/** The one thing you do: tell the concierge what you need, in your own words.
 *  Pinned at the bottom of the desk. ⌘↵ or the arrow sends. */
export function DispatchIntentInput() {
  const intent = useDispatchStore(s => s.intent)
  const pending = useDispatchStore(s => s.pending)
  const setIntent = useDispatchStore(s => s.setIntent)
  const submit = useDispatchStore(s => s.submit)
  const ref = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    submit()
    ref.current?.focus()
  }

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
          ref={ref}
          value={intent}
          onChange={e => setIntent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault()
              send()
            }
          }}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the desk's single input -- focus on open is the point
          autoFocus
          placeholder="tell me in your own words…"
          className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-relaxed text-foreground placeholder:text-comment focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={send}
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
    </div>
  )
}
