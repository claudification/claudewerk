/**
 * RobotAvatar -- the DiceBear `toon-head` face for one agent session.
 *
 * Deterministic from the seed (see lib/robot-identity.ts), rendered to an SVG
 * data URI so it drops into an <img> with no dangerouslySetInnerHTML and no
 * network round-trip. `radius: 50` + the derived disc colour give it the round
 * avatar-chip look. Memoized per seed, because the transcript re-renders this
 * on every assistant group.
 */
import { toonHead } from '@dicebear/collection'
import { createAvatar } from '@dicebear/core'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'

export function RobotAvatar({
  seed,
  backgroundColor,
  size = 18,
  className,
}: {
  seed: string
  /** Hex WITHOUT `#` -- DiceBear's wire format (see robotIdentity). */
  backgroundColor: string
  size?: number
  className?: string
}) {
  const uri = useMemo(
    () => createAvatar(toonHead, { seed, size, radius: 50, backgroundColor: [backgroundColor] }).toDataUri(),
    [seed, size, backgroundColor],
  )

  return <img src={uri} alt="" aria-hidden="true" width={size} height={size} className={cn('shrink-0', className)} />
}
