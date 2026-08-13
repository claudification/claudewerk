/**
 * `[follow]` DEBUG TRACING -- CURRENTLY OFF.
 *
 * The anchor/follow work (switch-pin, settle, ENGAGE/DISENGAGE transitions,
 * grew-but-not-following) shipped with a console firehose so a device-side
 * repro could be read straight out of the browser console. The engine is
 * stable now, so the noise costs more than it buys on every conversation
 * switch and every streamed tail append.
 *
 * TO RE-ENABLE: flip FOLLOW_DEBUG to `true` below and rebuild the web bundle.
 * Nothing else moves -- every `[follow]` line in the client goes through
 * `followDebug()`, so `rg 'followDebug\(' web/src` lists the full set.
 *
 * Deliberately a module const and not an env/localStorage read: the call sites
 * sit in layout effects and rAF settle loops on the transcript hot path, and a
 * dead `if (false)` costs nothing at runtime.
 */
export const FOLLOW_DEBUG = false

/** Console sink for `[follow]` traces. No-op while FOLLOW_DEBUG is false. */
export function followDebug(message: string): void {
  if (FOLLOW_DEBUG) console.debug(message)
}
