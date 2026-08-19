/**
 * Left pane of the Debug: control modal -- the grouped command list. Pure:
 * grouped commands in, selected key + select handler. Split out to keep the
 * modal shell under the file-size bar.
 */
import type { ControlCommandSpec } from '@shared/cc-control-commands'

interface DebugCommandPickerProps {
  grouped: { cc_control: ControlCommandSpec[]; daemon_op: ControlCommandSpec[] }
  activeKey: string
  onSelect: (key: string) => void
}

export function DebugCommandPicker({ grouped, activeKey, onSelect }: DebugCommandPickerProps) {
  return (
    <div className="w-56 border-r border-border overflow-y-auto shrink-0 text-[11px] font-mono">
      {(['cc_control', 'daemon_op'] as const).map(ch => (
        <div key={ch}>
          <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-fg-dim sticky top-0 bg-background">
            {ch === 'cc_control' ? 'cc_control (headless)' : 'daemon_op (daemon)'}
          </div>
          {grouped[ch].map(c => {
            const k = `${c.channel}:${c.command}`
            return (
              <button
                type="button"
                key={k}
                onClick={() => onSelect(k)}
                className={`w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-muted/50 ${k === activeKey ? 'bg-accent/15 text-accent' : ''}`}
              >
                <span className="truncate flex-1">{c.command}</span>
                {c.readOnly && <span className="text-[8px] text-emerald-400/60">RO</span>}
                {c.danger && <span className="text-[8px] text-red-400/80">DANGER</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
