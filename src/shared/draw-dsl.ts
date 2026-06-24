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
  font?: 'hand' | 'normal' | 'code' | 'nunito' | 'excalifont'
  bold?: boolean
}

/**
 * A named "scheme" look for a box -- a polished, presentation-grade preset (soft pastel
 * fill + ink title + grey subtitle + sketchy border, the recipe in scheme-variants.ts).
 * Authored in LIGHT hexes; the dark canvas inverts them for free (the `draw.colors` rule).
 */
export type SchemeVariant = 'blue' | 'gold' | 'green' | 'rose' | 'steel' | 'plain'

/** A generic shape (rectangle/ellipse/diamond). With title/subtitle/variant it renders in
 * the polished "scheme" look; otherwise a plain labelled shape. */
export interface ShapeNode {
  id: string
  kind: 'box' | 'ellipse' | 'diamond'
  /** Single centered label. Mutually exclusive with title/subtitle (those win if set). */
  text?: string
  /** Big ink headline -- pairs with `subtitle` for the scheme look. */
  title?: string
  /** Small grey strapline under the title. */
  subtitle?: string
  /** A polished pastel preset (see SchemeVariant); fills stroke/fill/recipe defaults. */
  variant?: SchemeVariant
  w?: number
  h?: number
  at?: [number, number]
  style?: Style
  data?: object
}

/** Primitive + semantic-UI + layout-container nodes. `id` addresses a node for the reverse diff. */
export type DslNode =
  | ShapeNode
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

// Intrinsic sizing + text metrics live in draw-dsl-size.ts; re-exported so importers of
// `@shared/draw-dsl` keep their existing surface.
export { fontSizePx, SIZE, textExtent } from './draw-dsl-size'

/** Structural guard: a DSL Scene (vs a raw Excalidraw serializeAsJSON scene). */
export function isDslScene(x: unknown): x is Scene {
  if (!x || typeof x !== 'object') return false
  const o = x as { v?: unknown; nodes?: unknown }
  return o.v === 1 && Array.isArray(o.nodes)
}
