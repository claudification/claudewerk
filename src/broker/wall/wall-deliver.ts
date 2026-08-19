/**
 * Putting one wall frame on one socket -- and the backpressure policy that
 * decides when not to.
 *
 * COALESCE, NEVER QUEUE. A frame a socket cannot take right now is DROPPED, not
 * buffered and not retried: the next tick already carries current state, so a
 * slow client gets the latest frame instead of a backlog of stale ones. The
 * `seq` gap the client sees is the evidence that it happened.
 *
 * Split out of wall-hub.ts because socket I/O policy and subscription
 * lifecycle are different jobs -- this one is the only thing here that knows
 * what a byte is.
 */

import type { WallFrame } from '../../shared/wall'

/** The slice of a WS socket the wall touches. Structural so tests need no Bun. */
export interface WallSocket {
  send(data: string): number
  getBufferedAmount?(): number
}

/** A socket whose buffer has genuinely ballooned past this is not draining; its
 *  frames are dropped rather than piled on. Matches the channel registry's own
 *  ceiling so the two agree about what "backlogged" means. */
const BACKPRESSURE_DROP_BYTES = 4 * 1024 * 1024

export type DeliveryResult = 'sent' | 'dropped' | 'dead'

export interface DeliverDeps {
  label: (ws: WallSocket) => string
  log: { warn(msg: string): void }
}

/** Returns 'dead' when the socket threw -- the caller must drop its seat. */
export type FrameDeliverer = (ws: WallSocket, frame: WallFrame, drops: number) => DeliveryResult

export function createDeliverer({ label, log }: DeliverDeps): FrameDeliverer {
  return (ws, frame, drops) => {
    const json = JSON.stringify(frame)
    try {
      const buffered = ws.getBufferedAmount?.() ?? 0
      if (buffered > BACKPRESSURE_DROP_BYTES) {
        log.warn(
          `[wall] drop frame seq=${frame.seq} to ${label(ws)} bytes=${json.length} buffered=${buffered} -- reason=backlogged (latest-wins, not queued) drops=${drops + 1}`,
        )
        return 'dropped'
      }
      if (ws.send(json) < 0) {
        log.warn(
          `[wall] drop frame seq=${frame.seq} to ${label(ws)} bytes=${json.length} -- reason=backpressure drops=${drops + 1}`,
        )
        return 'dropped'
      }
      return 'sent'
    } catch (err) {
      log.warn(`[wall] drop frame seq=${frame.seq} to ${label(ws)} -- reason=send-threw (${String(err)})`)
      return 'dead'
    }
  }
}
