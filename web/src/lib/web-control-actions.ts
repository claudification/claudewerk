/**
 * Web Debug Control -- opt-in actions shared by the settings toggle and the
 * command-palette entry. Combines the localStorage grant change with the WS
 * advertise/revoke so the broker's view and the browser's view stay in lock-step.
 */

import { wsSend } from '@/hooks/use-conversations'
import {
  buildWebControlAdvertise,
  buildWebControlRevoke,
  disableWebControl,
  enableWebControl,
  getActiveWebControlGrant,
} from './web-control-grant'

/** Opt in (or renew): fresh 1h grant + advertise to the broker. */
export function turnOnWebControl(): void {
  enableWebControl()
  const adv = buildWebControlAdvertise()
  if (adv) wsSend('web_control_advertise', adv)
}

/** Opt out: tell the broker to drop us, then clear the local grant. */
export function turnOffWebControl(): void {
  wsSend('web_control_revoke', buildWebControlRevoke())
  disableWebControl()
}

/** Flip the current state. Returns the new enabled state. */
export function toggleWebControl(): boolean {
  if (getActiveWebControlGrant()) {
    turnOffWebControl()
    return false
  }
  turnOnWebControl()
  return true
}
