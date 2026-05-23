/**
 * ProcessModelSegmented -- the claude backend's process-model picker
 * (Interactive PTY / Headless / Daemon). Selecting a tile maps to a
 * `transport` (claude-pty | claude-headless | claude-daemon); the parent owns
 * the (backend, headless) state and translates via `process-model.ts`.
 */

import { Kbd } from '@/components/ui/kbd'
import { cn, haptic } from '@/lib/utils'
import { type ClaudeTransport, PROCESS_MODEL_OPTIONS } from './process-model'

export function ProcessModelSegmented({
  value,
  onChange,
  shortcutHints = false,
  showHeading = true,
}: {
  value: ClaudeTransport
  onChange: (transport: ClaudeTransport) => void
  /** Render H/P hints on the PTY/Headless tiles (spawn dialog binds them). */
  shortcutHints?: boolean
  /** Render the "Process model" heading. Off when a parent Section already
   *  provides the title (the launch-profile editor). */
  showHeading?: boolean
}) {
  const activeHint = PROCESS_MODEL_OPTIONS.find(o => o.value === value)?.hint
  return (
    <div className="space-y-1">
      {showHeading && (
        <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">Process model</div>
      )}
      <div className="flex gap-1.5">
        {PROCESS_MODEL_OPTIONS.map(opt => {
          const hint = opt.value === 'claude-headless' ? 'H' : opt.value === 'claude-pty' ? 'P' : undefined
          return (
            <button
              key={opt.value}
              type="button"
              title={opt.hint}
              aria-pressed={value === opt.value}
              onClick={() => {
                onChange(opt.value)
                haptic('tick')
              }}
              className={cn(
                'flex-1 px-2 py-1 text-[11px] font-mono rounded transition-colors border inline-flex items-center justify-center gap-1.5',
                value === opt.value
                  ? 'bg-primary/15 text-primary border-primary/30'
                  : 'text-comment border-transparent hover:text-muted-foreground',
              )}
            >
              {opt.label}
              {shortcutHints && hint && <Kbd className="text-[10px] opacity-70">{hint}</Kbd>}
            </button>
          )
        })}
      </div>
      {activeHint && <div className="text-[9px] text-comment pl-0.5">{activeHint}</div>}
    </div>
  )
}
