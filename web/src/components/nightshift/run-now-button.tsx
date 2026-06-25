/**
 * RUN-NOW BUTTON -- manually kick off this project's night run right now.
 * It spawns REAL headless agents to work the queued tasks, so it confirms first.
 * Disabled while the queue is empty (parent) or a run this button fired is still
 * in flight (local). A failed trigger surfaces its reason inline.
 */

import { Play } from 'lucide-react'
import { useState } from 'react'
import { runNightshiftNow } from '@/hooks/use-nightshift-queue'

const CONFIRM = 'Run nightshift now? This spawns real agents to work the queued tasks.'

export function RunNowButton({ projectUri, disabled }: { projectUri: string; disabled: boolean }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function trigger() {
    if (!window.confirm(CONFIRM)) return
    setRunning(true)
    setError(null)
    try {
      const res = await runNightshiftNow(projectUri)
      if (!res.ok) setError(res.reason ?? 'run failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-400">{error}</span>}
      <button
        type="button"
        onClick={trigger}
        disabled={disabled || running}
        className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Play className="size-3.5" />
        {running ? 'Running…' : 'Run nightshift now'}
      </button>
    </div>
  )
}
