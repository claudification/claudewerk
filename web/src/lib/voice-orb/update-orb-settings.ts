/**
 * `update_orb_settings` -- the orb changing how IT sounds, on command ("talk
 * faster", "different voice", "go professional").
 *
 * Client-local: the settings are the panel's own control-panel prefs, so this
 * writes them directly (which persists to localStorage) and the live-push hooks
 * (`useLiveSpeed` / `useLiveVoice`) apply speed + voice to the running session at
 * once; a tone change is baked at mint, so it lands on the next summon.
 *
 * VALIDATED against the canonical lists -- voice is lossy, so a misheard voice or
 * tone is REJECTED (with the real options read back) rather than silently
 * defaulted; a wild speed is clamped to the API's range.
 */

import { clampVoiceOrbSpeed, VOICE_ORB_TONES, VOICE_ORB_VOICES } from '@shared/voice-orb-options'
import { useConversationsStore } from '@/hooks/use-conversations'

export interface OrbSettingsArgs {
  speed?: unknown
  voice?: unknown
  tone?: unknown
}

/** Narrow a spoken value against a fixed list. null = not provided; otherwise a
 *  match or a rejection with the real options read back (voice is lossy). */
function pickFromList(
  raw: unknown,
  list: readonly string[],
  kind: string,
): { ok: string } | { bad: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const v = raw.trim().toLowerCase()
  if (list.includes(v)) return { ok: v }
  return { bad: `"${raw}" is not a ${kind} -- pick one of: ${list.join(', ')}` }
}

export function runUpdateOrbSettings(args: OrbSettingsArgs): Record<string, unknown> {
  const patch: { voiceOrbSpeed?: number; voiceOrbVoice?: string; voiceOrbTone?: string } = {}
  const applied: string[] = []
  const rejected: string[] = []

  if (args.speed !== undefined && args.speed !== null && args.speed !== '') {
    patch.voiceOrbSpeed = clampVoiceOrbSpeed(args.speed)
    applied.push(`speed ${patch.voiceOrbSpeed}`)
  }

  const voice = pickFromList(args.voice, VOICE_ORB_VOICES, 'voice')
  if (voice && 'ok' in voice) {
    patch.voiceOrbVoice = voice.ok
    applied.push(`voice ${voice.ok}`)
  } else if (voice) rejected.push(voice.bad)

  const tone = pickFromList(args.tone, VOICE_ORB_TONES, 'tone')
  if (tone && 'ok' in tone) {
    patch.voiceOrbTone = tone.ok
    applied.push(`tone ${tone.ok}`)
  } else if (tone) rejected.push(tone.bad)

  if (applied.length === 0 && rejected.length === 0) {
    return { error: 'nothing to change -- name a speed, voice, or tone' }
  }
  if (Object.keys(patch).length > 0) {
    useConversationsStore.getState().updateControlPanelPrefs(patch)
  }

  return {
    applied: applied.length ? applied : undefined,
    rejected: rejected.length ? rejected : undefined,
    // Speed + voice are live; tone needs a fresh session.
    note: patch.voiceOrbTone ? 'the tone change applies on your next summon' : undefined,
  }
}
