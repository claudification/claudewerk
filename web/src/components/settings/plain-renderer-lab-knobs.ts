/**
 * The Plain Renderer Lab knob table -- what each experiment is and why you
 * would flip it. Kept out of the section component so the UI file stays a
 * renderer and this stays a description of the experiment space.
 */

import type { PlainRendererLabPrefs } from '@/lib/plain-renderer-lab'

export type Knob =
  | { key: keyof PlainRendererLabPrefs; kind: 'bool'; label: string; description: string }
  | {
      key: keyof PlainRendererLabPrefs
      kind: 'select'
      label: string
      description: string
      options: Array<string | number>
    }

export const KNOBS: Knob[] = [
  {
    key: 'anchorMode',
    kind: 'select',
    options: ['auto', 'native', 'js'],
    label: 'Anchoring',
    description:
      'Who holds your position when content above changes. auto = the browser where it has scroll anchoring (Chrome/Firefox, Safari 27+), our JS anchors where it does not. native/js force one side. Never both -- they double-compensate every prepend',
  },
  {
    key: 'sizing',
    kind: 'select',
    options: ['measured', 'flat'],
    label: 'Reserved group height',
    description:
      'measured = each group reserves its real height (from the shared per-conversation cache, else a content-derived estimate), so it barely moves when it renders. flat = one guess for every group, the original behavior and the jump amplifier',
  },
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
    label: 'Flat height (px)',
    description:
      'The one reserved height used while Reserved group height is "flat". Ignored otherwise. Closer to a real group = smaller first-encounter inflation, which is the whole argument for "measured"',
  },
]
