import { useState } from 'react'
import { useDebugLogView } from '@/hooks/use-debug-log-view'
import { usePanelResize } from '@/hooks/use-panel-resize'
import { copyLogText, type LogEntry } from '@/lib/debug-log'
import { DebugConsoleToolbar } from './debug-console-toolbar'

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  debug: 'text-cyan-400/70',
  log: 'text-foreground/80',
}

const RESIZE = { initialHeight: 240, minHeight: 120, maxHeightRatio: 0.7 }
const COPY_LINES = 200

function LogLine({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.t).toISOString().slice(11, 23)
  return (
    <div
      className={`flex gap-2 font-mono text-[11px] leading-relaxed ${LEVEL_COLORS[entry.level] || 'text-foreground'}`}
    >
      <span className="text-muted-foreground/50 shrink-0 select-none">{ts}</span>
      <span className="text-muted-foreground/50 shrink-0 w-10 select-none">{entry.level.toUpperCase()}</span>
      <span className="whitespace-pre-wrap break-all">{entry.args}</span>
    </div>
  )
}

export function DebugConsole({ onClose }: { onClose: () => void }) {
  const { entries, total, scrollRef, onScroll, clear } = useDebugLogView()
  const { height, fullscreen, toggleFullscreen, dragHandlers } = usePanelResize(RESIZE)
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    // Honours the level filter -- see copyLogText.
    navigator.clipboard.writeText(copyLogText(COPY_LINES))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className={`shrink-0 flex flex-col bg-background border-t border-border ${fullscreen ? 'fixed inset-0 z-[60]' : ''}`}
      style={{ height: fullscreen ? '100vh' : `${height}px` }}
    >
      {!fullscreen && (
        <div
          className="h-1.5 cursor-row-resize bg-transparent hover:bg-accent/30 transition-colors shrink-0"
          title="Drag to resize"
          {...dragHandlers}
        />
      )}
      <DebugConsoleToolbar
        shown={entries.length}
        total={total}
        copied={copied}
        fullscreen={fullscreen}
        onCopy={handleCopy}
        onClear={clear}
        onToggleFullscreen={toggleFullscreen}
        onClose={onClose}
      />
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto px-3 py-1">
        {entries.length === 0 && (
          <div className="text-muted-foreground/50 text-xs font-mono py-4 text-center">No log entries yet</div>
        )}
        {entries.map((entry, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
          // biome-ignore lint/suspicious/noArrayIndexKey: display-only log entries, no stable IDs
          <LogLine key={i} entry={entry} />
        ))}
      </div>
    </div>
  )
}
