/**
 * Debug console toolbar: the level filter + the copy/clear/fullscreen/close
 * actions. Split out of `debug-console` so the panel file stays about the panel
 * (resize, scroll-follow, rendering) and this stays about the controls.
 */

import { Copy, Maximize2, Minimize2, Trash2, X } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import {
  getLogLevelFilter,
  LOG_LEVELS,
  type LogLevel,
  subscribeLogFilter,
  toggleLogLevel,
} from '@/lib/debug-log-filter'
import { cn } from '@/lib/utils'

const LEVEL_ACTIVE: Record<LogLevel, string> = {
  error: 'text-red-400 border-red-400/50',
  warn: 'text-yellow-400 border-yellow-400/50',
  debug: 'text-cyan-400/70 border-cyan-400/40',
  log: 'text-foreground/80 border-foreground/30',
}

function LevelFilter() {
  const active = useSyncExternalStore(subscribeLogFilter, getLogLevelFilter)
  return (
    <div className="flex items-center gap-0.5">
      {LOG_LEVELS.map(level => {
        const on = active.has(level)
        return (
          <button
            key={level}
            type="button"
            onClick={() => toggleLogLevel(level)}
            aria-pressed={on}
            className={cn(
              'px-1 py-px text-[9px] font-mono uppercase tracking-wider border transition-colors',
              on ? LEVEL_ACTIVE[level] : 'text-fg-faint border-transparent hover:text-muted-foreground',
            )}
            title={on ? `Hide ${level} lines (view + copy)` : `Show ${level} lines`}
          >
            {level}
          </button>
        )
      })}
    </div>
  )
}

/** Both numbers only when a filter is actually hiding something. */
function formatCount(shown: number, total: number): string {
  return shown === total ? `${total}` : `${shown}/${total}`
}

function CopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" onClick={onCopy} className={ACTION} title="Copy last 200 visible lines">
      {copied ? <span className="text-[10px] font-mono text-green-400">copied</span> : <Copy className="size-3.5" />}
    </button>
  )
}

function FullscreenButton({ fullscreen, onToggle }: { fullscreen: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className={ACTION} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
      {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  )
}

export interface DebugConsoleToolbarProps {
  shown: number
  total: number
  copied: boolean
  fullscreen: boolean
  onCopy: () => void
  onClear: () => void
  onToggleFullscreen: () => void
  onClose: () => void
}

const ACTION = 'text-muted-foreground hover:text-foreground transition-colors p-1'

export function DebugConsoleToolbar(props: DebugConsoleToolbarProps) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-1 border-b border-border">
      <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider shrink-0">
        Debug Console ({formatCount(props.shown, props.total)})
      </span>
      <LevelFilter />
      <div className="flex items-center gap-1 shrink-0">
        <CopyButton copied={props.copied} onCopy={props.onCopy} />
        <button type="button" onClick={props.onClear} className={ACTION} title="Clear logs">
          <Trash2 className="size-3.5" />
        </button>
        <FullscreenButton fullscreen={props.fullscreen} onToggle={props.onToggleFullscreen} />
        <button type="button" onClick={props.onClose} className={ACTION} title="Close">
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
