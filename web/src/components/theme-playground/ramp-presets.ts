/**
 * The ramps from the theme lab, as presets you can land on and then edit.
 *
 * Each is a complete seven-step neutral ladder. The point of keeping all six
 * rather than only the winner: "too dark" and "too bright" are answers you give
 * by COMPARING, and a preset you can flip to in one click is worth more than a
 * paragraph describing it.
 *
 * Token roles + the snapshot serializer live in `rung-catalog.ts`.
 */

type Vars = Record<string, string>

const ladder = (
  sunken: string,
  base: string,
  raised: string,
  overlay: string,
  hover: string,
  sub: string,
  line: string,
  strong: string,
): Vars => ({
  'surface-sunken': sunken,
  background: base,
  'surface-raised': raised,
  'surface-overlay': overlay,
  'surface-hover': hover,
  'border-subtle': sub,
  border: line,
  'border-strong': strong,
})

export interface Preset {
  id: string
  name: string
  note: string
  vars: Vars
}

export const PRESETS: Preset[] = [
  {
    id: 'v1-deep',
    name: 'V1-deep (shipped)',
    note: 'Black floor, Tokyo Night separation above it.',
    vars: {
      ...ladder(
        'oklch(0.115 0.018 275)',
        'oklch(0.165 0.022 275)',
        'oklch(0.235 0.03 273)',
        'oklch(0.3 0.037 273)',
        'oklch(0.355 0.045 273)',
        'oklch(0.3 0.037 273)',
        'oklch(0.415 0.055 274)',
        'oklch(0.5 0.068 274)',
      ),
      foreground: 'oklch(0.9 0.045 275)',
      'fg-muted': 'oklch(0.76 0.05 275)',
      'fg-dim': 'oklch(0.62 0.05 274)',
      'fg-faint': 'oklch(0.52 0.05 274)',
    },
  },
  {
    id: 'v0-shipping',
    name: 'V0 (the old one)',
    note: 'What shipped before. Here so you can see what changed.',
    vars: {
      ...ladder(
        'oklch(0.145 0.025 265)',
        'oklch(0.15 0.02 260)',
        'oklch(0.18 0.02 260)',
        'oklch(0.18 0.02 260)',
        'oklch(0.25 0.02 260)',
        'oklch(0.32 0.02 260)',
        'oklch(0.32 0.02 260)',
        'oklch(0.32 0.02 260)',
      ),
      foreground: 'oklch(0.85 0.02 260)',
      'fg-muted': 'oklch(0.7 0.02 260)',
      'fg-dim': 'oklch(0.52 0.02 260)',
      'fg-faint': 'oklch(0.42 0.02 260)',
    },
  },
  {
    id: 'true-tn',
    name: 'True Tokyo Night',
    note: 'The enkia palette unmodified. Lighter page than V1-deep.',
    vars: {
      ...ladder(
        'oklch(0.204 0.016 285)',
        'oklch(0.226 0.021 280)',
        'oklch(0.278 0.032 275)',
        'oklch(0.318 0.04 273)',
        'oklch(0.36 0.048 274)',
        'oklch(0.318 0.04 273)',
        'oklch(0.409 0.055 274)',
        'oklch(0.496 0.068 274)',
      ),
      foreground: 'oklch(0.846 0.061 275)',
      'fg-muted': 'oklch(0.767 0.054 275)',
      'fg-dim': 'oklch(0.62 0.06 274)',
      'fg-faint': 'oklch(0.52 0.06 274)',
    },
  },
  {
    id: 'deeper',
    name: 'Deeper',
    note: 'Blacker page, panels pushed further up. Loudest separation.',
    vars: {
      ...ladder(
        'oklch(0.09 0.015 270)',
        'oklch(0.14 0.02 270)',
        'oklch(0.235 0.03 270)',
        'oklch(0.305 0.035 270)',
        'oklch(0.37 0.04 270)',
        'oklch(0.305 0.035 270)',
        'oklch(0.44 0.05 270)',
        'oklch(0.54 0.06 270)',
      ),
      foreground: 'oklch(0.94 0.02 270)',
      'fg-muted': 'oklch(0.78 0.04 270)',
      'fg-dim': 'oklch(0.64 0.04 270)',
      'fg-faint': 'oklch(0.54 0.04 270)',
    },
  },
  {
    id: 'warm',
    name: 'Warm slate',
    note: 'Amber-leaning neutral, so the yellow stops fighting a blue ground.',
    vars: {
      ...ladder(
        'oklch(0.12 0.008 70)',
        'oklch(0.168 0.01 70)',
        'oklch(0.238 0.012 70)',
        'oklch(0.3 0.014 70)',
        'oklch(0.355 0.016 70)',
        'oklch(0.3 0.014 70)',
        'oklch(0.415 0.018 70)',
        'oklch(0.5 0.02 70)',
      ),
      foreground: 'oklch(0.91 0.012 80)',
      'fg-muted': 'oklch(0.76 0.02 80)',
      'fg-dim': 'oklch(0.62 0.02 80)',
      'fg-faint': 'oklch(0.52 0.02 80)',
    },
  },
  {
    id: 'ink',
    name: 'Ink',
    note: 'Zero chroma. The accent does every bit of the colour work.',
    vars: {
      ...ladder(
        'oklch(0.115 0 0)',
        'oklch(0.168 0 0)',
        'oklch(0.238 0 0)',
        'oklch(0.3 0 0)',
        'oklch(0.355 0 0)',
        'oklch(0.3 0 0)',
        'oklch(0.415 0 0)',
        'oklch(0.5 0 0)',
      ),
      foreground: 'oklch(0.93 0 0)',
      'fg-muted': 'oklch(0.76 0 0)',
      'fg-dim': 'oklch(0.62 0 0)',
      'fg-faint': 'oklch(0.52 0 0)',
    },
  },
]
