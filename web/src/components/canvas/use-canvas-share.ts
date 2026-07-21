/**
 * Owner-side share state for one hosted canvas: current tier, link, expiry, and
 * the set/revoke actions. Kept out of the share-control component so the .tsx
 * stays a thin render. The token never leaves the owner UI except as the link.
 */

import type { CanvasShareTier, CanvasSummary } from '@shared/protocol'
import { useCallback, useState } from 'react'
import { canvasShareUrl, revokeCanvasShare, shareCanvas } from './canvas-editor-io'

/** Offered link lifetimes. null = until revoked. */
export const SHARE_DURATIONS: { label: string; hours: number | null }[] = [
  { label: '1 hour', hours: 1 },
  { label: '8 hours', hours: 8 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: 'Until revoked', hours: null },
]

/** Default lifetime for a fresh share -- a link you forget about should lapse. */
const DEFAULT_HOURS = 24

export interface CanvasShareState {
  shared: boolean
  tier: CanvasShareTier
  url: string | null
  busy: boolean
  /** Chosen lifetime for the NEXT set/extend (not necessarily the stored one). */
  hours: number | null
  setHours: (hours: number | null) => void
  /** Epoch ms the live link dies, or undefined when it never does. */
  expiresAt?: number
  /** Create, re-tier, or extend the public share. */
  setTier: (tier: CanvasShareTier) => Promise<void>
  /** Re-issue the current tier with the selected lifetime (the extend button). */
  extend: () => Promise<void>
  /** Revoke -- the link dies immediately. */
  revoke: () => Promise<void>
}

// fallow-ignore-next-line complexity -- a share hook: state seeds + guarded async actions, irreducible.
export function useCanvasShare(canvas: CanvasSummary | null): CanvasShareState {
  const [shared, setShared] = useState(canvas?.shared ?? false)
  const [tier, setTierState] = useState<CanvasShareTier>(canvas?.shareTier ?? 'read')
  const [token, setToken] = useState<string | null>(canvas?.shareToken ?? null)
  const [expiresAt, setExpiresAt] = useState<number | undefined>(canvas?.shareExpiresAt)
  const [hours, setHours] = useState<number | null>(DEFAULT_HOURS)
  const [busy, setBusy] = useState(false)

  const setTier = useCallback(
    async (next: CanvasShareTier) => {
      if (!canvas || busy) return
      setBusy(true)
      const res = await shareCanvas(canvas.id, next, hours)
      if (res) {
        setToken(res.token)
        setExpiresAt(res.expiresAt)
        setTierState(next)
        setShared(true)
      }
      setBusy(false)
    },
    [canvas, busy, hours],
  )

  // Extending is just re-issuing the same tier: the broker recomputes the
  // deadline from now and keeps the existing token, so the link stays valid.
  const extend = useCallback(() => setTier(tier), [setTier, tier])

  const revoke = useCallback(async () => {
    if (!canvas || busy) return
    setBusy(true)
    if (await revokeCanvasShare(canvas.id)) {
      setShared(false)
      setToken(null)
      setExpiresAt(undefined)
    }
    setBusy(false)
  }, [canvas, busy])

  return {
    shared,
    tier,
    url: token ? canvasShareUrl(token) : null,
    busy,
    hours,
    setHours,
    expiresAt,
    setTier,
    extend,
    revoke,
  }
}
