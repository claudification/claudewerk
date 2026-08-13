/**
 * Speech TRANSPORT settings: which way the audio travels, and a probe that says
 * how far away each option actually is from where you are standing.
 *
 * Split out of items-voice-engine because that file is about the MICROPHONE and
 * this is about the NETWORK -- and because the whole voice saga was a geography
 * problem nobody measured, which earns the topic its own home.
 */

import { lazy, Suspense, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SettingCheckbox } from './settings-inputs'
import type { SettingItem } from './settings-item'

// LAZY: the probe + its modal never ride in the index bundle.
const VoiceLatencyModal = lazy(() => import('./voice-latency-modal').then(m => ({ default: m.VoiceLatencyModal })))

/** Button + the modal it opens, as one self-contained control. */
function MeasureLatency() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" className="text-xs" onClick={() => setOpen(true)}>
        Measure
      </Button>
      {open && (
        <Suspense fallback={null}>
          <VoiceLatencyModal open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}

export const VOICE_TRANSPORT_ITEMS: SettingItem[] = [
  {
    tab: 'voice',
    group: 'Transport',
    label: 'Direct to the Cloudflare edge',
    description:
      'ON: mic audio goes straight from this browser to the speech Worker at the nearest Cloudflare colo, with the broker out of the audio path (it only signs a short-lived token). OFF relays audio through the broker instead -- close on the home LAN, a round trip to the house from anywhere else. Takes effect on the next recording.',
    keywords: 'voice transport cloudflare worker direct broker relay latency edge colo',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.voiceDirectToDeepgram !== false}
        onChange={v => ctx.updatePrefs({ voiceDirectToDeepgram: v })}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Transport',
    label: 'Measure transport latency',
    description:
      'Ping each speech transport 10 times from THIS browser and compare round trips -- including Deepgram direct, the old path, as a reference. Measures distance, not transcription speed.',
    keywords: 'voice latency ping rtt measure probe benchmark deepgram cloudflare broker compare',
    render: () => <MeasureLatency />,
  },
]
