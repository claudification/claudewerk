// Live message pulses for THE CANVAS: watches the store's inter-conversation
// activity ring and keeps each NEW send (key minted after mount) alive as a
// transient pulse edge for PULSE_TTL_MS. Keys are client-monotonic, so this
// is immune to broker/client clock skew; history never animates.
import type { Edge } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type InterConvActivity, useConversationsStore } from '@/hooks/use-conversations'

const PULSE_TTL_MS = 2600

type LivePulse = InterConvActivity & { receivedAt: number }

export function useMessagePulses(presentIds: ReadonlySet<string>): Edge[] {
  const activity = useConversationsStore(s => s.interConvActivity)
  const [live, setLive] = useState<LivePulse[]>([])
  const seenKeyRef = useRef<number | null>(null)

  useEffect(() => {
    if (seenKeyRef.current === null) {
      // First run after mount: everything already in the ring is history.
      seenKeyRef.current = activity.reduce((max, a) => Math.max(max, a.key), 0)
      return
    }
    const seen = seenKeyRef.current
    const fresh = activity.filter(a => a.key > seen)
    if (fresh.length === 0) return
    seenKeyRef.current = fresh.reduce((max, a) => Math.max(max, a.key), seen)
    const receivedAt = Date.now()
    setLive(prev => [...prev, ...fresh.map(a => ({ ...a, receivedAt }))])
    // Prune by local receive time; a later batch's timer also sweeps earlier
    // batches (cutoff is computed when it fires), so cancelling on re-run is safe.
    const timer = setTimeout(() => {
      const cutoff = Date.now() - PULSE_TTL_MS
      setLive(prev => prev.filter(p => p.receivedAt > cutoff))
    }, PULSE_TTL_MS + 100)
    return () => clearTimeout(timer)
  }, [activity])

  return useMemo(
    () =>
      live.flatMap(p =>
        presentIds.has(p.from) && presentIds.has(p.to)
          ? [
              {
                id: `pulse:${p.key}`,
                source: p.from,
                target: p.to,
                type: 'pulse' as const,
                data: { status: p.status },
                zIndex: 20,
              },
            ]
          : [],
      ),
    [live, presentIds],
  )
}
