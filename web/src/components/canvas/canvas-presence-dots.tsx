/**
 * Live-presence dots for a canvas room. Shared by the owner island and the
 * public guest viewer so both read the same roster the same way.
 */

import type { CanvasPeer } from '@shared/protocol'

export function PresenceDots({ peers }: { peers: CanvasPeer[] }) {
  // A room of one is just you -- no point drawing a crowd of yourself.
  if (peers.length < 2) return null
  return (
    <span className="flex items-center gap-1 shrink-0" title={`${peers.length} editing`}>
      {peers.slice(0, 5).map(p => (
        <span
          key={p.peerId}
          className="w-2.5 h-2.5 rounded-full border border-background"
          style={{ background: p.color }}
          title={p.name}
        />
      ))}
    </span>
  )
}
