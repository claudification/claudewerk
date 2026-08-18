/**
 * PUSH-TO-TALK GUARD — stop a chord from opening the microphone.
 *
 * THE COLLISION (2026-08-18): the Pulse strip peeks while `mod+alt` is held. If
 * push-to-talk is bound to an Alt or Meta key, that same hold ALSO armed the
 * mic — so reaching for a glance at the fleet started recording you.
 *
 * Two guards, because the two orderings fail differently:
 *
 *   FOREIGN MODIFIER — you pressed Cmd first, then Alt. The Alt keydown already
 *     carries `metaKey`, so the chord is knowable immediately and voice never
 *     starts. Cheap and exact.
 *
 *   GRACE WINDOW — you pressed Alt first, then Cmd a few milliseconds later.
 *     Nothing on the Alt keydown says a chord is coming, so the start is held
 *     for CHORD_GRACE_MS and abandoned if any other key arrives first.
 *
 * The window is a real cost: it delays the start of every recording. 70ms is
 * chosen to be longer than the gap between two fingers landing on a deliberate
 * chord and shorter than anything a person perceives as lag — and speech has a
 * far larger natural lead-in than that before the first phoneme.
 */

/** How long a hold waits to see whether it is actually the start of a chord. */
export const CHORD_GRACE_MS = 70

export interface ModifierFlags {
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

/** The modifier a hold key IS, so its own flag does not read as foreign. */
function selfModifier(holdKey: string): keyof ModifierFlags | null {
  if (holdKey.startsWith('Alt')) return 'altKey'
  if (holdKey.startsWith('Meta') || holdKey.startsWith('OS')) return 'metaKey'
  if (holdKey.startsWith('Control')) return 'ctrlKey'
  if (holdKey.startsWith('Shift')) return 'shiftKey'
  return null
}

/**
 * True when a modifier OTHER than the hold key itself is already down.
 *
 * A hold key that is a modifier sets its own flag on its own keydown, so that
 * one is excluded — otherwise binding push-to-talk to Alt would mean Alt could
 * never start it.
 */
export function hasForeignModifier(holdKey: string, e: ModifierFlags): boolean {
  const self = selfModifier(holdKey)
  const flags: Array<keyof ModifierFlags> = ['altKey', 'metaKey', 'ctrlKey', 'shiftKey']
  return flags.some(flag => flag !== self && e[flag])
}
