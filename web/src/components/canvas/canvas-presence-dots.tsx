/**
 * Live-presence dots for a canvas room. Shared by the owner island and the
 * public guest viewer so both read the same roster the same way.
 */

import type { CanvasPeer } from '@shared/protocol'

/** How many dots to draw before collapsing the rest into a "+N" count. Keeps the
 *  island from overflowing Excalidraw's fixed top-right slot when a crowd joins. */
const MAX_DOTS = 3

export function PresenceDots({ peers }: { peers: CanvasPeer[] }) {
  // A room of one is just you -- no point drawing a crowd of yourself.
  if (peers.length < 2) return null
  const shown = peers.slice(0, MAX_DOTS)
  const overflow = peers.length - shown.length
  return (
    <span className="flex items-center gap-1 shrink-0" title={`${peers.length} editing`}>
      {shown.map(p => (
        <span
          key={p.peerId}
          className="w-2.5 h-2.5 rounded-full border border-background"
          style={{ background: p.color }}
          title={p.name}
        />
      ))}
      {overflow > 0 && <span className="text-[10px] leading-none text-muted-foreground tabular-nums">+{overflow}</span>}
    </span>
  )
}
