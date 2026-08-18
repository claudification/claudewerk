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
const VoiceTimingsModal = lazy(() => import('./voice-timings-modal').then(m => ({ default: m.VoiceTimingsModal })))

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

/** The per-dictation breakdown, as opposed to the network distance above. */
function ShowTimings() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" className="text-xs" onClick={() => setOpen(true)}>
        Show
      </Button>
      {open && (
        <Suspense fallback={null}>
          <VoiceTimingsModal open={open} onClose={() => setOpen(false)} />
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
      'Audio goes browser -> nearest Cloudflare colo, broker out of the path. Off relays through the broker instead.',
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
    description: 'Ping each transport 10 times from this browser and compare. Distance, not transcription speed.',
    keywords: 'voice latency ping rtt measure probe benchmark deepgram cloudflare broker compare',
    render: () => <MeasureLatency />,
  },
  {
    tab: 'voice',
    group: 'Transport',
    label: 'Dictation timings',
    description:
      'What the last 10 dictations actually cost, measured at every seam on this device. Says how much speech was lost before capture started, and whether the pre-roll caught it. Copies as a paste-ready tree.',
    keywords: 'voice timing timings dictation breakdown measure preroll lost first word gap stats copy tree profile',
    render: () => <ShowTimings />,
  },
]
