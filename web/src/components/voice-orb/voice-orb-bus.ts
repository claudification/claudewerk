/**
 * Summon bus for the voice orb -- the EAGER sliver that keeps the orb's WebRTC
 * chunk out of the index bundle.
 *
 * The command palette entry (and any future hotkey) calls `summonVoiceOrb()`;
 * the lazy gate in app.tsx watches `voiceOrbBus.useArmed()` and only then pulls
 * the host chunk. Nothing else in this module may import the orb.
 */

import { createLazyBus } from '@/lib/lazy-bus'

/** `toggle` = the palette verb (summon if away, dismiss if here). */
type VoiceOrbIntent = 'toggle' | 'summon' | 'dismiss'

export const voiceOrbBus = createLazyBus<VoiceOrbIntent>()

export function summonVoiceOrb(): void {
  voiceOrbBus.open('toggle')
}
