/**
 * THE HEADLINE: what the fleet is costing per hour, right now.
 *
 * THIS COMPONENT IS THE ONLY PART OF A2 SUBSCRIBED TO THE WALL CHANNEL. Frames
 * arrive at ~2 Hz; if the pane itself held the subscription, every tile, every
 * bar and both splits would re-render twice a second to animate one number. So
 * the live half is fenced in here and the rest of the pane re-renders only when
 * its own 60-second feed changes.
 *
 * ONE CLOCK. Samples are stamped with the BROWSER's clock at fold time, never
 * with the broker's `at`. The two can be minutes apart, and a window whose
 * cutoff came from one clock while its samples came from the other would drop
 * real spending or keep expired spending -- silently, and worse the more skewed
 * the two hosts are. The frame's `at` is used for exactly one thing: knowing that
 * a NEW frame arrived.
 */

import { useEffect, useRef } from 'react'
import { useWallChannel } from '@/hooks/use-wall-channel'
import {
  BURN_MIN_OBSERVED_MS,
  BURN_WINDOW_MS,
  burnReading,
  burnSparkline,
  emptyAccrual,
  foldBurnFrame,
} from '@/lib/wall/burn'
import { formatRate } from '@/lib/wall/burn-splits'
import { useWallClock } from '../use-wall-clock'
import { BurnSparkline } from './burn-sparkline'

const WINDOW_MIN = Math.round(BURN_WINDOW_MS / 60_000)

export function BurnLive() {
  const { pulse, at } = useWallChannel()
  // A second clock, because the rate has to DECAY when nothing is spending --
  // and "nothing is spending" is exactly the case where no frame arrives to
  // re-render us. Without it a fleet that went quiet would hold its last rate.
  const now = useWallClock(1000)
  const acc = useRef(emptyAccrual())

  // Fold once per FRAME, not once per render: the clock above re-renders this
  // component every second, and re-folding the same rows would be work with no
  // reader (the deltas are already zero by then).
  useEffect(() => {
    if (at === 0) return
    foldBurnFrame(acc.current, pulse, Date.now())
  }, [at, pulse])

  const reading = burnReading(acc.current, now)
  const buckets = burnSparkline(acc.current, now)
  const measuring = reading.usdPerHour === null

  return (
    <div className="wall-burn-live">
      <span className="wall-burn-rate" data-measuring={measuring || undefined}>
        {formatRate(reading.usdPerHour)}
      </span>
      <div className="wall-burn-spark-wrap">
        <BurnSparkline buckets={buckets} windowMin={WINDOW_MIN} />
        <span className="wall-burn-note">
          {measuring
            ? `measuring ${Math.floor(reading.observedMs / 1000)}/${BURN_MIN_OBSERVED_MS / 1000}s`
            : `live · ${WINDOW_MIN}m`}
        </span>
      </div>
    </div>
  )
}
