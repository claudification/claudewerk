/**
 * Per-kind body renderers. Each takes a parsed block and returns an HTML
 * fragment; the shell in render.ts supplies the frame, prompt and footer.
 *
 * Spike scope: every control is INERT. Buttons, inputs and sliders render at
 * full fidelity but are `disabled` -- nothing stamps yet.
 *
 * SECURITY: `swatch`, `font` and `img` come from agent-authored text and land
 * in style/src attributes, where escaping alone is not enough. They are
 * allowlisted (see safeColor / safeFont / safeUrl), not sanitised.
 */
import { type AnvilBlock, type AnvilOption, attrNumber, attrString, galleryRender, isMulti } from './types'

export function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Hex only. Anything else is dropped rather than escaped into a style attr. */
function safeColor(c: string): string | null {
  return /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : null
}

/** Conservative family name: letters, digits, spaces, dashes. No quotes, no url(). */
function safeFont(f: string): string | null {
  const t = f.trim().replace(/^["']|["']$/g, '')
  return /^[\w][\w -]{0,48}$/.test(t) ? t : null
}

function safeUrl(u: string): string | null {
  const t = u.trim()
  return /^https?:\/\/[^\s"'<>]+$/i.test(t) ? t : null
}

const MARK = '<span class="anvil-mark" aria-hidden="true"></span>'

function optionMeta(o: AnvilOption): string {
  return o.hint ? `<span class="anvil-hint">${esc(o.hint)}</span>` : ''
}

export function renderChoice(b: AnvilBlock): string {
  if (!b.options.length) return '<p class="anvil-empty">No options.</p>'
  const multi = isMulti(b)
  const rows = b.options
    .map((o, i) => {
      const danger = o.danger ? ' anvil-row-danger' : ''
      return `<button type="button" class="anvil-row${danger}" disabled>
        <span class="anvil-key">${multi ? MARK : esc(String(i + 1))}</span>
        <span class="anvil-row-main"><span class="anvil-label">${esc(o.label)}</span>${optionMeta(o)}</span>
      </button>`
    })
    .join('')
  return `<div class="anvil-rows" role="group">${rows}</div>${multi ? submitBar(b) : ''}`
}

function cardFace(b: AnvilBlock, o: AnvilOption): string {
  const mode = galleryRender(b)
  if (mode === 'swatch') {
    const chips = (o.swatch ?? [])
      .map(safeColor)
      .filter((c): c is string => c !== null)
      .map(c => `<i style="background:${c}"></i>`)
      .join('')
    return `<span class="anvil-swatch">${chips || '<i class="anvil-swatch-empty"></i>'}</span>`
  }
  if (mode === 'type') {
    const fam = o.font ? safeFont(o.font) : null
    const style = fam ? ` style="font-family:'${fam}',serif"` : ''
    return `<span class="anvil-type"${style}>${esc(o.sample || 'Aa Bb Cc')}</span>`
  }
  if (mode === 'image') {
    const url = o.img ? safeUrl(o.img) : null
    if (url) return `<img class="anvil-img" src="${esc(url)}" alt="${esc(o.label)}" loading="lazy">`
    return '<span class="anvil-img anvil-img-missing"></span>'
  }
  return ''
}

export function renderGallery(b: AnvilBlock): string {
  if (!b.options.length) return '<p class="anvil-empty">No cards.</p>'
  const mode = galleryRender(b)
  const cards = b.options
    .map((o, i) => {
      const face = cardFace(b, o)
      return `<button type="button" class="anvil-card" disabled>
        ${face}
        <span class="anvil-card-foot">
          <span class="anvil-key">${esc(String(i + 1))}</span>
          <span class="anvil-label">${esc(o.label)}</span>
        </span>
        ${o.hint ? `<span class="anvil-hint">${esc(o.hint)}</span>` : ''}
      </button>`
    })
    .join('')
  return `<div class="anvil-grid anvil-grid-${mode}">${cards}</div>${submitBar(b)}`
}

export function renderInput(b: AnvilBlock): string {
  if (!b.fields.length) return '<p class="anvil-empty">No fields.</p>'
  const rows = b.fields
    .map(f => {
      const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''
      const opt = f.required ? '' : '<span class="anvil-optional">optional</span>'
      const control =
        f.type === 'longtext'
          ? `<textarea class="anvil-input" rows="3" disabled${ph}></textarea>`
          : f.type === 'bool'
            ? '<span class="anvil-switch" aria-hidden="true"></span>'
            : `<input class="anvil-input" type="${f.type === 'number' ? 'number' : 'text'}" disabled${ph}>`
      const mono = f.type === 'path' || f.type === 'url' ? ' anvil-field-mono' : ''
      return `<div class="anvil-field${mono}">
        <label class="anvil-field-label">${esc(f.label)}${opt}</label>
        ${control}
      </div>`
    })
    .join('')
  return `<div class="anvil-fields">${rows}</div>${submitBar(b)}`
}

export function renderScale(b: AnvilBlock): string {
  if (!b.dials.length) return '<p class="anvil-empty">No dials.</p>'
  const steps = Math.min(11, Math.max(2, attrNumber(b, 'steps', 5)))
  const rows = b.dials
    .map(d => {
      const pct = ((d.value - 1) / Math.max(1, steps - 1)) * 100
      return `<div class="anvil-dial">
        <span class="anvil-pole">${esc(d.left)}</span>
        <span class="anvil-track"><i class="anvil-knob" style="left:${pct.toFixed(1)}%"></i></span>
        <span class="anvil-pole anvil-pole-right">${esc(d.right)}</span>
      </div>`
    })
    .join('')
  return `<div class="anvil-dials">${rows}</div>${submitBar(b)}`
}

export function renderNote(b: AnvilBlock): string {
  const tone = attrString(b, 'tone', 'info')
  const cls = tone === 'danger' ? 'anvil-note-danger' : tone === 'warn' ? 'anvil-note-warn' : 'anvil-note-info'
  const text = b.prose || b.prompt
  if (!text) return ''
  const paras = text
    .split('\n')
    .filter(Boolean)
    .map(l => `<p>${esc(l)}</p>`)
    .join('')
  return `<div class="anvil-note ${cls}">${paras}</div>`
}

function submitBar(b: AnvilBlock): string {
  const label = attrString(b, 'submit', 'Confirm')
  return `<div class="anvil-actions"><button type="button" class="anvil-submit" disabled>${esc(label)}</button></div>`
}
