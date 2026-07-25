/**
 * Virtualizer Lab -- the Experiments settings tab. Live A/B knobs for the
 * transcript virtualizer's follow/pin/placement machinery (lib/virtualizer-lab.ts).
 * All defaults reproduce production behavior; every change applies immediately
 * (prefs are live zustand state) except the two isScrolling knobs, which bind
 * when the scroll listener attaches and need a reload.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import {
  DEFAULT_VIRTUALIZER_LAB,
  labSummary,
  resolveVirtualizerLab,
  type VirtualizerLabPrefs,
} from '@/lib/virtualizer-lab'
import { type LabKnob, LabKnobRows, LabResetHeader } from './lab-knobs-ui'

const KNOBS: Array<LabKnob<keyof VirtualizerLabPrefs>> = [
  {
    key: 'manualGrowthPin',
    kind: 'bool',
    label: 'Manual growth pin',
    description:
      'Our totalSize-growth re-pin. OFF = native end-pin is the SOLE follow driver (single-driver experiment)',
  },
  {
    key: 'followOnAppend',
    kind: 'bool',
    label: 'Native follow on append',
    description: 'Virtual-core scrolls to end itself when items are appended while pinned',
  },
  {
    key: 'scrollEndThreshold',
    kind: 'select',
    options: [0, 20, 40, 80, 160, 320],
    label: 'Scroll-end threshold (px)',
    description: 'How close to the (estimated) end still counts as "at end" for the native re-pin',
  },
  {
    key: 'gateNativePinWhenDetached',
    kind: 'bool',
    label: 'Gate native pin when detached',
    description: 'Zero the threshold while follow is off, so incoming content can never drag a scrolled-up reader down',
  },
  {
    key: 'pinMethod',
    kind: 'select',
    options: ['scrollToEnd', 'scrollHeight'],
    label: 'Pin method',
    description:
      'scrollToEnd = virtualizer item math (can undershoot late-measured content); scrollHeight = exact DOM bottom',
  },
  {
    key: 'inFlightPlacement',
    kind: 'select',
    options: ['inside', 'outside'],
    label: 'In-flight UI placement',
    description:
      'Streaming text/thinking, pill, spinner: inside the last virtual item (measured) or below the virtualizer',
  },
  {
    key: 'bannersPlacement',
    kind: 'select',
    options: ['inside', 'outside'],
    label: 'Banners + queued placement',
    description:
      'Permission/question banners and queued bubbles: inside the last virtual item or below the virtualizer',
  },
  {
    key: 'liveEstimate',
    kind: 'select',
    options: [20, 40, 80, 120, 200],
    label: 'Live group estimate (px)',
    description: 'First-frame height guess for the streaming slot; its snap to measured height is a jump suspect',
  },
  {
    key: 'overscan',
    kind: 'select',
    options: [1, 3, 5, 8, 12],
    label: 'Overscan',
    description: 'Rows rendered beyond the viewport',
  },
  {
    key: 'useScrollendEvent',
    kind: 'bool',
    label: 'Use scrollend event (reload)',
    description: 'End isScrolling on the native scrollend event instead of a timeout',
  },
  {
    key: 'isScrollingResetDelay',
    kind: 'select',
    options: [50, 100, 150, 300, 500],
    label: 'isScrolling reset delay (reload)',
    description: 'ms after the last scroll event before scroll-direction latching resets',
  },
]

export function VirtualizerLabSection() {
  const stored = useConversationsStore(s => s.controlPanelPrefs.virtualizerLab)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const lab = resolveVirtualizerLab(stored)
  const summary = labSummary(lab)

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground leading-relaxed">
        Live experiment knobs for the transcript scroll/follow machinery. Defaults = current production behavior.
        Changes apply immediately; test one knob at a time and watch the <span className="font-mono">[lab]</span> /{' '}
        <span className="font-mono">[follow]</span> console lines.
      </div>
      <LabResetHeader summary={summary} onReset={() => updatePrefs({ virtualizerLab: {} })} />
      <LabKnobRows
        knobs={KNOBS}
        values={lab}
        defaults={DEFAULT_VIRTUALIZER_LAB}
        onChange={(key, value) => updatePrefs({ virtualizerLab: { ...stored, [key]: value } })}
      />
    </div>
  )
}
