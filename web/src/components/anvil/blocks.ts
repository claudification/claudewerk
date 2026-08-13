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
import { type IconName, icon, resolveIcon } from './icons'
import {
  type AnvilBlock,
  type AnvilField,
  type AnvilKind,
  type AnvilOption,
  attrNumber,
  attrString,
  type FieldType,
  type GalleryRender,
  galleryRender,
  isMulti,
  type NoteTone,
} from './types'

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
  return `<div class="anvil-rows" role="group">${rows}</div>`
}

/** One face per render mode. Strategy map: a new mode is one entry. */
const FACES: Record<GalleryRender, (o: AnvilOption) => string> = {
  swatch: o => {
    const chips = (o.swatch ?? [])
      .map(safeColor)
      .filter((c): c is string => c !== null)
      .map(c => `<i style="background:${c}"></i>`)
      .join('')
    return `<span class="anvil-swatch">${chips || '<i class="anvil-swatch-empty"></i>'}</span>`
  },
  type: o => {
    const fam = o.font ? safeFont(o.font) : null
    const style = fam ? ` style="font-family:'${fam}',serif"` : ''
    return `<span class="anvil-type"${style}>${esc(o.sample || 'Aa Bb Cc')}</span>`
  },
  image: o => {
    const url = o.img ? safeUrl(o.img) : null
    if (!url) return '<span class="anvil-img anvil-img-missing"></span>'
    return `<img class="anvil-img" src="${esc(url)}" alt="${esc(o.label)}" loading="lazy">`
  },
  card: () => '',
}

function cardFace(b: AnvilBlock, o: AnvilOption): string {
  return (FACES[galleryRender(b)] ?? FACES.card)(o)
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
  // Same rule as @choice: single select locks on the click itself, so a submit
  // button would be a second, meaningless step.
  return `<div class="anvil-grid anvil-grid-${mode}">${cards}</div>`
}

function textControl(type: string, f: AnvilField): string {
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''
  return `<input class="anvil-input" type="${type}" disabled${ph}>`
}

/**
 * One control per field type. This was a ternary chain that collapsed every
 * type except `number` to a plain text input, so `secret` -- the one type whose
 * whole purpose is masking -- rendered its value in the clear, and `date`/`url`
 * silently lost their native controls.
 */
const CONTROLS: Record<FieldType, (f: AnvilField) => string> = {
  text: f => textControl('text', f),
  number: f => textControl('number', f),
  secret: f => textControl('password', f),
  url: f => textControl('url', f),
  date: f => textControl('date', f),
  path: f => textControl('text', f),
  longtext: f => {
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''
    return `<textarea class="anvil-input" rows="3" disabled${ph}></textarea>`
  },
  bool: () => '<span class="anvil-switch" aria-hidden="true"></span>',
}

const MONO_FIELDS = new Set<FieldType>(['path', 'url', 'secret'])

export function renderInput(b: AnvilBlock): string {
  if (!b.fields.length) return '<p class="anvil-empty">No fields.</p>'
  const rows = b.fields
    .map(f => {
      const opt = f.required ? '' : '<span class="anvil-optional">optional</span>'
      const control = (CONTROLS[f.type] ?? CONTROLS.text)(f)
      const mono = MONO_FIELDS.has(f.type) ? ' anvil-field-mono' : ''
      return `<div class="anvil-field${mono}">
        <label class="anvil-field-label">${esc(f.label)}${opt}</label>
        ${control}
      </div>`
    })
    .join('')
  return `<div class="anvil-fields">${rows}</div>`
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
  return `<div class="anvil-dials">${rows}</div>`
}

const NOTE_CLASS: Record<NoteTone, string> = {
  info: 'anvil-note-info',
  warn: 'anvil-note-warn',
  danger: 'anvil-note-danger',
}

const NOTE_ICON: Record<NoteTone, IconName> = {
  info: 'info',
  warn: 'triangle-alert',
  danger: 'octagon-alert',
}

/** Non-fatal parse complaints. Always rendered next to what they describe. */
export function warnings(b: AnvilBlock): string {
  if (!b.warnings.length) return ''
  return `<div class="anvil-warn">${b.warnings.map(w => esc(w)).join(' · ')}</div>`
}

export function renderNote(b: AnvilBlock): string {
  const tone = attrString(b, 'tone', 'info') as NoteTone
  const cls = NOTE_CLASS[tone] ?? NOTE_CLASS.info
  const text = b.prose || b.prompt
  if (!text) return ''
  const paras = text
    .split('\n')
    .filter(Boolean)
    .map(l => `<p>${esc(l)}</p>`)
    .join('')
  const mark = icon(resolveIcon(b.attrs.icon, NOTE_ICON[tone] ?? 'info'))
  // A note carries its own warnings INSIDE the tinted box. The shell cannot
  // append them, because a note has no frame to append them to and they would
  // float naked in the transcript.
  return `<div class="anvil-note ${cls}"><span class="anvil-icon">${mark}</span><div class="anvil-note-body">${paras}${warnings(b)}</div></div>`
}

/**
 * Which kinds need an explicit submit. Single-select locks on the click itself,
 * so a button there would be a second, meaningless step.
 */
const NEEDS_SUBMIT: Record<AnvilKind, (b: AnvilBlock) => boolean> = {
  choice: isMulti,
  gallery: isMulti,
  input: () => true,
  scale: () => true,
  note: () => false,
}

export function submitBar(b: AnvilBlock): string {
  if (!(NEEDS_SUBMIT[b.kind] ?? (() => false))(b)) return ''
  const label = attrString(b, 'submit', 'Confirm')
  return `<div class="anvil-actions"><button type="button" class="anvil-submit" disabled>${esc(label)}</button></div>`
}
