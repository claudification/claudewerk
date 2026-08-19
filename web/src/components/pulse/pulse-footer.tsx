/** The grammar cheat-sheet. Tapping a sigil types it, so the surface teaches
 *  itself on a phone where there are no hints to hover. */
const SIGILS: Array<{ key: string; label: string }> = [
  { key: '!', label: 'wants you' },
  { key: '!!', label: '+working' },
  { key: '!!!', label: 'blocked' },
  { key: '@', label: 'project' },
  { key: '#', label: 'tag' },
  { key: '~30m', label: 'window' },
  { key: '$1', label: 'cost' },
  { key: '%80', label: 'context' },
  { key: '&', label: 'host' },
  { key: ':', label: 'model' },
  { key: '-', label: 'exclude' },
  { key: '+over', label: 'machine-run' },
]

export function PulseFooter({ onSigil }: { onSigil: (token: string) => void }) {
  return (
    <div className="flex gap-x-3 gap-y-1 flex-wrap px-3 py-2 border-t border-primary/10 bg-surface-sunken">
      <span className="text-[10px] text-comment hidden sm:inline">
        <span className="font-mono text-accent">↑↓</span> move
        <span className="font-mono text-accent ml-2">⏎</span> open
        <span className="font-mono text-accent ml-2">esc</span> close
      </span>
      {SIGILS.map(s => (
        <button
          key={s.key}
          type="button"
          onClick={() => onSigil(s.key)}
          className="text-[10px] text-comment hover:text-accent transition-colors"
        >
          <span className="font-mono text-accent">{s.key}</span> {s.label}
        </button>
      ))}
    </div>
  )
}
