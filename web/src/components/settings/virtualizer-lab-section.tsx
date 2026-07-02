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
import { SettingRow } from './settings-inputs'

type Knob =
  | { key: keyof VirtualizerLabPrefs; kind: 'bool'; label: string; description: string }
  | {
      key: keyof VirtualizerLabPrefs
      kind: 'select'
      label: string
      description: string
      options: Array<string | number>
    }

const KNOBS: Knob[] = [
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

  const set = (key: keyof VirtualizerLabPrefs, value: boolean | string | number) =>
    updatePrefs({ virtualizerLab: { ...stored, [key]: value } })

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground leading-relaxed">
        Live experiment knobs for the transcript scroll/follow machinery. Defaults = current production behavior.
        Changes apply immediately; test one knob at a time and watch the <span className="font-mono">[lab]</span> /{' '}
        <span className="font-mono">[follow]</span> console lines.
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className={summary ? 'text-amber-500' : 'text-muted-foreground'}>
          {summary ? `active: ${summary}` : 'all defaults (production behavior)'}
        </span>
        {summary && (
          <button
            type="button"
            onClick={() => updatePrefs({ virtualizerLab: {} })}
            className="px-1.5 py-0.5 border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            reset all
          </button>
        )}
      </div>
      {KNOBS.map(knob => {
        const isDefault = lab[knob.key] === DEFAULT_VIRTUALIZER_LAB[knob.key]
        return (
          <SettingRow key={knob.key} label={knob.label} description={knob.description}>
            <div className="flex items-center gap-1.5">
              {!isDefault && <span className="size-1.5 rounded-full bg-amber-500" title="non-default" />}
              {knob.kind === 'bool' ? (
                <input
                  aria-label={knob.label}
                  type="checkbox"
                  checked={lab[knob.key] as boolean}
                  onChange={e => set(knob.key, e.target.checked)}
                  className="accent-primary size-4"
                />
              ) : (
                <select
                  aria-label={knob.label}
                  value={String(lab[knob.key])}
                  onChange={e => {
                    const raw = e.target.value
                    const asNum = Number(raw)
                    set(knob.key, Number.isNaN(asNum) ? raw : asNum)
                  }}
                  className="bg-card border border-border text-foreground text-[10px] px-1 py-0.5 font-mono"
                >
                  {knob.options.map(o => (
                    <option key={String(o)} value={String(o)}>
                      {String(o)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </SettingRow>
        )
      })}
    </div>
  )
}
