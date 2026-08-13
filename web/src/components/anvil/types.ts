/**
 * ANVIL -- Agent-Native Visual Interaction Language.
 *
 * An agent writes an ```anvil fence mid-sentence; the transcript renders it as
 * real UI in place, instead of a code block. Spike scope: RENDER ONLY. Nothing
 * here stamps, locks, or talks to the broker yet.
 *
 * The parser is deliberately TOTAL -- see parse.ts. This is agent-authored
 * content arriving token by token, so a throw here would white-screen a whole
 * conversation.
 */

export type AnvilKind = 'choice' | 'gallery' | 'input' | 'scale' | 'note'

export const ANVIL_KINDS: readonly AnvilKind[] = ['choice', 'gallery', 'input', 'scale', 'note']

/** How a @gallery draws each card. */
export type GalleryRender = 'image' | 'swatch' | 'type' | 'card'

export type FieldType = 'text' | 'longtext' | 'number' | 'bool' | 'secret' | 'path' | 'url' | 'date'

export const FIELD_TYPES: readonly FieldType[] = ['text', 'longtext', 'number', 'bool', 'secret', 'path', 'url', 'date']

/** A `-` row: an option in a @choice or a card in a @gallery. */
export interface AnvilOption {
  value: string
  label: string
  hint?: string
  /** `- !wipe | ...` marks this single row destructive. */
  danger?: boolean
  img?: string
  swatch?: string[]
  font?: string
  sample?: string
}

/** A `_` row in an @input. */
export interface AnvilField {
  name: string
  type: FieldType
  label: string
  placeholder?: string
  required: boolean
}

/** A `%` row in a @scale. */
export interface AnvilDial {
  name: string
  left: string
  right: string
  /** 1-based notch, clamped into the block's step count. */
  value: number
}

export type NoteTone = 'info' | 'warn' | 'danger'

export interface AnvilBlock {
  kind: AnvilKind
  /** Author-supplied `id=`, else derived from the block body (stable). */
  id: string
  /** Set when the id was derived rather than authored. */
  derivedId: boolean
  prompt: string
  subtext: string
  /** Bare attrs land as `true`. */
  attrs: Record<string, string | boolean>
  options: AnvilOption[]
  fields: AnvilField[]
  dials: AnvilDial[]
  /** `>` lines, for @note. */
  prose: string
  /** Non-fatal parse complaints, surfaced in the rendered block. */
  warnings: string[]
}

export interface AnvilDoc {
  blocks: AnvilBlock[]
  /** True while the fence is still streaming: render, but never interactive. */
  partial: boolean
}

export function attrString(block: AnvilBlock, key: string, fallback = ''): string {
  const v = block.attrs[key]
  return typeof v === 'string' ? v : fallback
}

export function attrNumber(block: AnvilBlock, key: string, fallback: number): number {
  const v = block.attrs[key]
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN
  return Number.isFinite(n) ? n : fallback
}

export function galleryRender(block: AnvilBlock): GalleryRender {
  const v = attrString(block, 'render', 'image')
  return v === 'swatch' || v === 'type' || v === 'card' ? v : 'image'
}

export function isMulti(block: AnvilBlock): boolean {
  return attrString(block, 'select', 'one') === 'many'
}
