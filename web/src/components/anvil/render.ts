/**
 * AnvilDoc -> HTML string.
 *
 * Emits a string rather than React because that is how this transcript already
 * renders fences (marked -> HTML -> post-mount hydration for Mermaid/Shiki).
 * Matching the existing pattern keeps the hot path untouched and skips React
 * root lifecycle entirely. When stamping lands, only this file is replaced --
 * parse.ts and types.ts survive as-is.
 */
import { esc, renderChoice, renderGallery, renderInput, renderNote, renderScale } from './blocks'
import { parseAnvil } from './parse'
import type { AnvilBlock, AnvilKind } from './types'

type BodyRenderer = (block: AnvilBlock) => string

/** Strategy map, not a switch chain: a new kind is one entry plus one renderer. */
const BODIES: Record<AnvilKind, BodyRenderer> = {
  choice: renderChoice,
  gallery: renderGallery,
  input: renderInput,
  scale: renderScale,
  note: renderNote,
}

/**
 * ASCII only, on purpose. `◫` and `⇔` fell out of the transcript's monospace
 * stack into a fallback font and rendered as a tofu box. Every ask block is a
 * question anyway, so one mark serves all of them and the kind is carried by
 * the body, not by a glyph the font may not have.
 */
const KIND_ICON: Record<AnvilKind, string> = {
  choice: '?',
  gallery: '?',
  input: '?',
  scale: '?',
  note: '',
}

function warnings(block: AnvilBlock): string {
  if (!block.warnings.length) return ''
  const items = block.warnings.map(w => esc(w)).join(' · ')
  return `<div class="anvil-warn">${items}</div>`
}

function shell(block: AnvilBlock, partial: boolean): string {
  const body = (BODIES[block.kind] ?? renderNote)(block)

  // A note is chrome-less: it is prose, not a question.
  if (block.kind === 'note') return `${body}${warnings(block)}`

  const icon = KIND_ICON[block.kind]
  const head = block.prompt
    ? `<div class="anvil-prompt"><span class="anvil-icon">${esc(icon)}</span>${esc(block.prompt)}</div>`
    : ''
  const sub = block.subtext ? `<div class="anvil-subtext">${esc(block.subtext)}</div>` : ''
  const state = partial ? 'streaming' : 'preview'

  return `<section class="anvil-block" data-anvil-id="${esc(block.id)}" data-anvil-kind="${esc(block.kind)}">
    ${head}${sub}${body}${warnings(block)}
    <footer class="anvil-foot"><span>${state}</span></footer>
  </section>`
}

/**
 * Entry point for the markdown renderer.
 *
 * `closed` is false while the fence is still streaming. A block whose last
 * option has not arrived yet must never look answerable, so a partial doc
 * renders with a streaming footer and (since every control is already inert in
 * this spike) no interaction at all.
 */
export function renderAnvilFence(source: string, closed: boolean): string {
  let doc: ReturnType<typeof parseAnvil>
  try {
    doc = parseAnvil(source, { partial: !closed })
  } catch (err) {
    // parseAnvil is total, so this is unreachable by contract. Belt and braces:
    // a transcript must never white-screen because an agent typed something odd.
    const why = err instanceof Error ? err.message : 'unknown'
    return `<div class="anvil-fallback"><div class="anvil-warn">anvil parse failed: ${esc(why)}</div><pre><code>${esc(source)}</code></pre></div>`
  }

  if (!doc.blocks.length) {
    return `<div class="anvil-fallback"><pre><code>${esc(source)}</code></pre></div>`
  }

  const inner = doc.blocks.map(b => shell(b, doc.partial)).join('')
  return `<div class="anvil-doc${doc.partial ? ' anvil-doc-streaming' : ''}">${inner}</div>`
}
