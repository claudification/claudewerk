/**
 * The VOICE ORB's settings rows (Input tab -> "Voice orb" group).
 *
 * Lives here rather than inline in settings-page.tsx, which is already far past
 * any sane file size -- new groups get their own module.
 *
 * Both knobs are per-device prefs, not server settings: the TONE is baked into
 * the session at mint (so it applies on the orb's next summon), while SPEED is
 * also pushed to a live session between turns, so the slider is audible
 * immediately.
 */

import { VOICE_ORB_VOICES } from '@shared/voice-orb-options'
import { MAX_ORB_SPEED, MIN_ORB_SPEED, VOICE_ORB_TONES } from '@/components/voice-orb/voice-orb-tone'

interface RowContext {
  prefs: { voiceOrbTone: string; voiceOrbSpeed: number; voiceOrbVoice: string }
  updatePrefs: (patch: Record<string, unknown>) => void
}

/** Every one of these was verified to mint against the live API. */
const VOICE_BLURB: Record<string, string> = {
  marin: 'marin -- the default',
  cedar: 'cedar -- warm, low',
  alloy: 'alloy -- neutral',
  ash: 'ash -- dry, gravelly',
  ballad: 'ballad -- lilting',
  coral: 'coral -- bright',
  echo: 'echo -- flat, clipped',
  sage: 'sage -- calm',
  shimmer: 'shimmer -- airy',
  verse: 'verse -- theatrical',
}

const TONE_LABEL: Record<string, string> = {
  professional: 'Professional -- attitude off',
  snarky: 'Snarky -- the default',
  homicidal: 'Homicidal -- calmly menacing',
  overkill: 'Overkill -- operatic, swears',
}

export function VoiceOrbToneRow({ ctx, ariaLabel }: { ctx: RowContext; ariaLabel: string }) {
  return (
    <select
      aria-label={ariaLabel}
      value={ctx.prefs.voiceOrbTone}
      onChange={e => ctx.updatePrefs({ voiceOrbTone: e.target.value })}
      className="border border-border bg-muted px-2 py-1 font-mono text-foreground text-xs"
    >
      {VOICE_ORB_TONES.map(tone => (
        <option key={tone} value={tone}>
          {TONE_LABEL[tone] ?? tone}
        </option>
      ))}
    </select>
  )
}

export function VoiceOrbVoiceRow({ ctx, ariaLabel }: { ctx: RowContext; ariaLabel: string }) {
  return (
    <select
      aria-label={ariaLabel}
      value={ctx.prefs.voiceOrbVoice}
      onChange={e => ctx.updatePrefs({ voiceOrbVoice: e.target.value })}
      className="border border-border bg-muted px-2 py-1 font-mono text-foreground text-xs"
    >
      {VOICE_ORB_VOICES.map(v => (
        <option key={v} value={v}>
          {VOICE_BLURB[v] ?? v}
        </option>
      ))}
    </select>
  )
}

export function VoiceOrbSpeedRow({ ctx, ariaLabel }: { ctx: RowContext; ariaLabel: string }) {
  const speed = Number(ctx.prefs.voiceOrbSpeed) || 1
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={ariaLabel}
        type="range"
        min={MIN_ORB_SPEED}
        max={MAX_ORB_SPEED}
        step={0.05}
        value={speed}
        onChange={e => ctx.updatePrefs({ voiceOrbSpeed: Number(e.target.value) })}
        className="accent-primary w-32"
      />
      <span className="w-10 text-right font-mono text-foreground text-xs">{speed.toFixed(2)}x</span>
    </div>
  )
}
