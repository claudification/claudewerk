/**
 * Deterministic transcript-entry UUID. Broker-synthesized transcript entries
 * (boot / launch / shell receipts) need a stable v5-shaped id so re-emitting the
 * same event is idempotent (no duplicate rows). Keyed on a caller-built string.
 */

import { createHash } from 'node:crypto'

export function deterministicUuid(key: string): string {
  const h = createHash('sha1').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
