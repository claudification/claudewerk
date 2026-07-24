/**
 * Plain Renderer Lab -- the Experiments settings tab (shown only while the
 * plain renderer is active). Live A/B knobs for the plain transcript's
 * SCROLL-BACK anchoring (lib/plain-renderer-lab.ts). All defaults reproduce
 * production behavior; every change applies immediately (prefs are live
 * zustand state -- the renderer re-reads them on the next commit).
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import {
  DEFAULT_PLAIN_RENDERER_LAB,
  type PlainRendererLabPrefs,
  plainLabSummary,
  resolvePlainRendererLab,
} from '@/lib/plain-renderer-lab'
import { SettingRow } from './settings-inputs'

type Knob =
  | { key: keyof PlainRendererLabPrefs; kind: 'bool'; label: string; description: string }
  | {
      key: keyof PlainRendererLabPrefs
      kind: 'select'
      label: string
      description: string
      options: Array<string | number>
    }

const KNOBS: Knob[] = [
  {
    key: 'contentVisibility',
    kind: 'bool',
    label: 'content-visibility',
    description:
      'Skip offscreen group layout via content-visibility:auto. OFF = plain flow, real heights from first layout, nothing inflates above the viewport (the jump amplifier is gone; costs offscreen-skip perf on huge windows)',
  },
  {
    key: 'intrinsicSize',
    kind: 'select',
    options: [120, 200, 320, 480, 640],
    label: 'Intrinsic size estimate (px)',
    description:
      'contain-intrinsic-size for a not-yet-rendered group. Only matters while content-visibility is ON; closer to real height = smaller first-encounter inflation',
  },
  {
    key: 'prependAnchor',
    kind: 'bool',
    label: 'Prepend anchor (scrollHeight delta)',
    description:
      'The Safari-safe scrollHeight-delta compensation applied when older history is inserted above the viewport',
  },
  {
    key: 'aboveAnchor',
    kind: 'bool',
    label: 'Above-viewport anchor (ResizeObserver)',
    description:
      'Compensates a content-visibility group inflating from estimate to real height while it sits above the viewport. Redundant when content-visibility is OFF',
  },
  {
    key: 'overflowAnchor',
    kind: 'select',
    options: ['none', 'auto'],
    label: 'overflow-anchor',
    description:
      'none = we own anchoring in JS (today). auto = native browser scroll anchoring drives it (Chrome/Firefox; no-op in Safari) -- pair with the JS anchors OFF to avoid double-compensation',
  },
]

export function PlainRendererLabSection() {
  const stored = useConversationsStore(s => s.controlPanelPrefs.plainRendererLab)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const lab = resolvePlainRendererLab(stored)
  const summary = plainLabSummary(lab)

  const set = (key: keyof PlainRendererLabPrefs, value: boolean | string | number) =>
    updatePrefs({ plainRendererLab: { ...stored, [key]: value } })

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground leading-relaxed">
        Live experiment knobs for the plain renderer's scroll-back anchoring. Stick-to-bottom is settled; this is the
        load-older / height-inflation path. Defaults = current production behavior. Change one knob at a time and watch
        the <span className="font-mono">[window]</span> console lines.
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className={summary ? 'text-amber-500' : 'text-muted-foreground'}>
          {summary ? `active: ${summary}` : 'all defaults (production behavior)'}
        </span>
        {summary && (
          <button
            type="button"
            onClick={() => updatePrefs({ plainRendererLab: {} })}
            className="px-1.5 py-0.5 border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            reset all
          </button>
        )}
      </div>
      {KNOBS.map(knob => {
        const isDefault = lab[knob.key] === DEFAULT_PLAIN_RENDERER_LAB[knob.key]
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
