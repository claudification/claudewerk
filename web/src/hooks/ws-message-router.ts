/**
 * `ws.onmessage`: parse, meter, then route.
 *
 * Every inbound frame goes exactly one of three ways -- bypassed to a listener
 * that owns it, bypassed to the browser (toast / control request), or buffered
 * for the next frame's batched render. The metering wraps all three so the wire
 * stats describe the same message the router just placed.
 */

import { isPerfEnabled, record as perfRecord } from '@/lib/perf-metrics'
import { recordWireIn } from '@/lib/wire-stats'
import type { DashboardMessage } from './use-websocket-handlers'
import { routeBypassMessage } from './ws-bypass-routes'
import { enqueueMessage } from './ws-flush-buffer'
import { routeNoticeMessage } from './ws-notice-routes'
import type { WsSend } from './ws-socket-types'
import { recordIn } from './ws-stats'

export function createMessageHandler(send: WsSend): (event: MessageEvent) => void {
  return event => {
    const raw = event.data as string
    recordIn(raw.length)
    const wsT0 = isPerfEnabled() ? performance.now() : 0
    let msg: DashboardMessage | undefined
    try {
      msg = JSON.parse(raw) as DashboardMessage

      // --- Bypass buffer: latency-sensitive handlers ---
      if (routeBypassMessage(msg)) return
      if (routeNoticeMessage(msg, send)) return

      // --- Buffer: state-updating messages ---
      enqueueMessage(msg)
    } catch {
      // Ignore parse errors
    } finally {
      if (wsT0) {
        const t = (msg as { type?: string } | undefined)?.type ?? 'parse-error'
        const cpuMs = performance.now() - wsT0
        perfRecord('ws', 'onmessage', cpuMs, `${(raw.length / 1024).toFixed(1)}KB ${t}`)
        // Same span, keyed on type, with the parsed payload so a fat message
        // can be broken down field-by-field (see wire-stats/payload-anatomy).
        recordWireIn(t, raw.length, cpuMs, msg)
      }
    }
  }
}
