/**
 * AgentShellHost -- renders agent-attached host shells OFF-SCREEN.
 *
 * Mounted once at the app root. For each shell the agent has attached (via the
 * web debug-control terminal ops), it mounts a real ShellPane in a hidden,
 * off-screen container: the pane subscribes, ingests the sentinel replay + live
 * bytes, and registers its xterm buffer for read/screenshot -- all WITHOUT the
 * fullscreen shell overlay, so the user's view is never hijacked. Real (off-
 * screen) dimensions are required so xterm fits to a sane cols/rows; opacity is
 * NOT zeroed so screenshots capture real pixels.
 */

import { ShellPane } from '@/components/shell-pane'
import { useAgentShellsStore } from '@/lib/web-control-shells'

const HOST_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: -100000,
  top: 0,
  width: 1024,
  height: 640,
  pointerEvents: 'none',
  overflow: 'hidden',
  zIndex: -1,
}

const PANE_STYLE: React.CSSProperties = { position: 'absolute', inset: 0 }

export function AgentShellHost() {
  const attached = useAgentShellsStore(s => s.attached)
  const ids = Object.keys(attached)
  if (ids.length === 0) return null
  return (
    <div aria-hidden style={HOST_STYLE} data-agent-shell-host>
      {ids.map(shellId => (
        <div key={shellId} style={PANE_STYLE}>
          <ShellPane shellId={shellId} className="absolute inset-0" />
        </div>
      ))}
    </div>
  )
}
