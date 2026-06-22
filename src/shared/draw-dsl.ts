/**
 * Agent shapes DSL -- the compact wire format Claude (the agent host) authors instead
 * of raw Excalidraw element JSON (20+ boilerplate fields each). The client expands a
 * `Scene` to Excalidraw skeletons -> `convertToExcalidrawElements` -> elements tagged
 * with `customData.dslId`; on submit it reverses the edited scene back to a compact
 * `Scene` + a `SceneDiff`. See `.claude/docs/plan-excalidraw-dsl.md` (the contract).
 *
 * This module is the PURE core (types + guards + sizing): no Excalidraw runtime, so it
 * is bun-testable and shared by the expander, the canvas (web) and the reverse pass.
 */

/** A compact agent-authored scene. `flow` auto-lays bare nodes from edges; `free` uses `at`. */
export interface Scene {
  v: 1
  layout?: 'free' | 'flow'
  nodes: DslNode[]
  edges?: Edge[]
}

export interface Style {
  stroke?: string
  fill?: string
  fillStyle?: 'hachure' | 'solid' | 'cross-hatch'
  rough?: 0 | 1 | 2
  font?: 'hand' | 'normal' | 'code'
  bold?: boolean
}

/** Primitive + semantic-UI + layout-container nodes. `id` addresses a node for the reverse diff. */
export type DslNode =
  | {
      id: string
      kind: 'box' | 'ellipse' | 'diamond'
      text?: string
      w?: number
      h?: number
      at?: [number, number]
      style?: Style
      data?: object
    }
  | { id?: string; kind: 'text'; text: string; at?: [number, number]; size?: 's' | 'm' | 'l'; style?: Style }
  | { id: string; kind: 'button'; text: string; variant?: 'primary' | 'ghost'; at?: [number, number]; data?: object }
  | { id: string; kind: 'input'; label?: string; placeholder?: string; at?: [number, number]; data?: object }
  | { id: string; kind: 'checkbox'; text: string; checked?: boolean; at?: [number, number]; data?: object }
  | { id: string; kind: 'card'; title?: string; w?: number; at?: [number, number]; children: DslNode[]; data?: object }
  | { id: string; kind: 'nav'; items: string[]; at?: [number, number]; data?: object }
  | { id: string; kind: 'image'; url: string; w?: number; h?: number; at?: [number, number]; data?: object }
  | { id: string; kind: 'mermaid'; def: string; w?: number; h?: number; at?: [number, number]; data?: object }
  | {
      id: string
      kind: 'screen'
      title?: string
      w?: number
      h?: number
      at?: [number, number]
      children: DslNode[]
      data?: object
    }
  | {
      kind: 'row' | 'col'
      gap?: number
      align?: 'start' | 'center' | 'end'
      at?: [number, number]
      children: DslNode[]
    }
  | { kind: 'grid'; cols: number; gap?: number; at?: [number, number]; children: DslNode[] }

export type Edge = { from: string; to: string; text?: string; arrow?: '->' | '<->' | '--'; dashed?: boolean }

/** Container kinds drive layout; they are compiled away (no element of their own). */
export type ContainerKind = 'row' | 'col' | 'grid' | 'card' | 'screen'

export function isContainer(kind: DslNode['kind']): kind is ContainerKind {
  return kind === 'row' || kind === 'col' || kind === 'grid' || kind === 'card' || kind === 'screen'
}

/**
 * Excalidraw element skeleton (the input to `convertToExcalidrawElements`). Kept as a
 * loose structural type here so this module stays free of the heavy Excalidraw import;
 * the canvas casts it at the boundary.
 */
export interface Skeleton {
  type: 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line' | 'frame'
  id?: string
  x?: number
  y?: number
  width?: number
  height?: number
  text?: string
  label?: { text: string; fontSize?: number; strokeColor?: string }
  fontSize?: number
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  roughness?: number
  roundness?: { type: number } | null
  fontFamily?: number
  textAlign?: 'left' | 'center' | 'right'
  points?: number[][] // line/arrow geometry, relative to x,y
  // arrow binding
  start?: { id: string }
  end?: { id: string }
  startArrowhead?: string | null
  endArrowhead?: string | null
  // frame
  children?: string[]
  name?: string
}

/** Per-element metadata written to `customData` after convert, keyed by skeleton id. */
export interface NodeMeta {
  dslId: string
  role: 'agent'
  data?: object
}

/** A user-drawn element with no `dslId` -- the annotation layer (compact descriptor). */
export interface Annotation {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  text?: string
  /** Optional marker via `customData.role` (e.g. `'comment'`). The annotation layer is
   * detected by ABSENCE of a dslId (the signal); this is forward-compat for deliberate notes. */
  role?: string
}

/** Bounds/label change of an agent node, keyed by dslId. */
export interface NodeChange {
  dslId: string
  at?: [number, number]
  w?: number
  h?: number
  text?: string
  frame?: string
}

/**
 * What the user did, computed on submit against the seeded scene. `added` is the
 * annotation layer (no dslId); the rest reference agent nodes by dslId.
 */
export interface SceneDiff {
  added: Annotation[]
  removed: string[]
  moved: NodeChange[]
  resized: NodeChange[]
  relabeled: NodeChange[]
}

/** A positioned node (absolute coords) -- the layout pass output, the skeleton pass input. */
export interface Placed {
  node: DslNode
  x: number
  y: number
  w: number
  h: number
  children?: Placed[]
}

// --- intrinsic sizing (no canvas; rough text metrics good enough for wireframes) ---
export const SIZE = {
  box: [160, 60],
  ellipse: [160, 80],
  diamond: [160, 80],
  button: [140, 44],
  inputField: [220, 40],
  checkbox: 24,
  nav: 44,
  image: [220, 140],
  mermaid: [360, 260],
  gap: 24,
  pad: 20,
  titleBar: 30,
  charW: 8.5,
  lineH: 22,
} as const

const FONT_PX = { s: 16, m: 20, l: 28 } as const

/** Font size in px for a text node's `size` (default `m`). */
export const fontSizePx = (size?: 's' | 'm' | 'l'): number => FONT_PX[size ?? 'm']

/** Rough rendered width/height of a single-line label at a given font size. */
export function textExtent(text: string, fontPx = 20): { w: number; h: number } {
  const lines = text.split('\n')
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
  const scale = fontPx / 20
  return { w: Math.max(20, Math.round(longest * SIZE.charW * scale)), h: Math.round(lines.length * SIZE.lineH * scale) }
}

/** Structural guard: a DSL Scene (vs a raw Excalidraw serializeAsJSON scene). */
export function isDslScene(x: unknown): x is Scene {
  if (!x || typeof x !== 'object') return false
  const o = x as { v?: unknown; nodes?: unknown }
  return o.v === 1 && Array.isArray(o.nodes)
}
