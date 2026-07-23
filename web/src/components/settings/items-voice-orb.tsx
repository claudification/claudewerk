/** The VOICE ORB's dials (per-device prefs; rows live in voice-orb-rows.tsx). */

import type { SettingItem } from './settings-item'
import { VoiceOrbSpeedRow, VoiceOrbToneRow, VoiceOrbVoiceRow } from './voice-orb-rows'

export const VOICE_ORB_ITEMS: SettingItem[] = [
  {
    tab: 'voice',
    group: 'Voice orb',
    label: 'Tone',
    description: 'How much attitude the orb ships with. Applies on its next summon.',
    keywords: 'voice orb tone persona snark professional homicidal overkill personality',
    render: (ctx, ariaLabel) => <VoiceOrbToneRow ctx={ctx} ariaLabel={ariaLabel} />,
  },
  {
    tab: 'voice',
    group: 'Voice orb',
    label: 'Voice',
    description:
      'Which OpenAI voice it speaks with. Changing it restarts the orb (OpenAI locks the voice once it has spoken).',
    keywords: 'voice orb speaker timbre marin cedar alloy ash ballad coral echo sage shimmer verse',
    render: (ctx, ariaLabel) => <VoiceOrbVoiceRow ctx={ctx} ariaLabel={ariaLabel} />,
  },
  {
    tab: 'voice',
    group: 'Voice orb',
    label: 'Speaking rate',
    description:
      'How fast the orb talks (0.25x - 1.5x, the API ceiling). Applies to a live session on its next sentence.',
    keywords: 'voice orb speed rate faster slower pace speech tempo',
    render: (ctx, ariaLabel) => <VoiceOrbSpeedRow ctx={ctx} ariaLabel={ariaLabel} />,
  },
]
