/**
 * Dialog MCP Tool - JSON Schema & Types
 *
 * Declarative UI system for rich user interactions via MCP channel.
 * Replaces AskUserQuestion (disabled when channels are active).
 *
 * Claude sends a JSON layout, dashboard renders it as a modal,
 * user interacts, result flows back as a single structured response.
 */

import type { DialogWidth, EventHandler } from './dialog-live'
import { validateLiveExtensions } from './dialog-live'

// ─── Design Tokens ─────────────────────────────────────────────────

export type DialogColor = 'primary' | 'secondary' | 'muted' | 'accent' | 'destructive' | 'success' | 'warning' | 'info'
export type ButtonVariant = 'default' | 'primary' | 'outline' | 'ghost'
export type ButtonIntent = 'neutral' | 'destructive' | 'success'
export type AlertIntent = 'info' | 'warning' | 'error' | 'success'

// ─── Component Types ───────────────────────────────────────────────

// Content components (display only)

export interface MarkdownComponent {
  type: 'Markdown'
  id?: string
  content?: string // inline markdown text
  file?: string // path to a markdown/text file (resolved by agent host, mutually exclusive with content)
  color?: DialogColor
}

export interface DiagramComponent {
  type: 'Diagram'
  id?: string
  content: string
  /**
   * Live dialogs only: let the user click a diagram NODE and attach a short note.
   * Requires `id`. Notes ride the form state as `values[id] = { nodeId: note }`,
   * keyed by the node's source identifier (e.g. `A` in `A[Start]`), and arrive in
   * the submit payload so you can redraw the diagram addressing each note.
   */
  commentable?: boolean
}

/**
 * Interactive whiteboard canvas, backed by Excalidraw. The user can draw, edit, move,
 * annotate, and (unless readOnly) submit the result back.
 *
 * SEED IT with a compact agent shapes DSL `Scene` as the `content` JSON string -- you
 * author SHAPES, not raw Excalidraw elements; the client expands them (layout, bound
 * arrows, sketchy UI macros) so you do NO pixel math:
 *
 *   { "v":1, "layout":"flow"?, "nodes":[ ... ], "edges":[ ... ]? }
 *
 *   nodes (each addressable by `id` for the submit diff):
 *     {id,kind:"box"|"ellipse"|"diamond",text?,title?,subtitle?,variant?,w?,h?,style?,data?}
 *     {id?,kind:"text",text,size?:"s"|"m"|"l"}
 *     {id,kind:"button",text,variant?:"primary"|"ghost"}
 *     {id,kind:"input",label?,placeholder?}   {id,kind:"checkbox",text,checked?}
 *     {id,kind:"card",title?,children:[...]}   {id,kind:"screen",title?,w?,children:[...]}
 *     {id,kind:"nav",items:[...]}              {id,kind:"image",url,w?,h?}
 *   layout containers (do the geometry; you only nest):
 *     {kind:"row"|"col",gap?,align?,children:[...]}   {kind:"grid",cols,gap?,children:[...]}
 *   edges (bind arrows by node id): {from,to,text?,arrow?:"->"|"<->"|"--",dashed?}
 *     -- an edge `text` renders as a white "pill" chip centred on the connector.
 *   SCHEME look (polished presentation cards): give a box `title`+`subtitle`+`variant`
 *     ("blue"|"gold"|"green"|"rose"|"steel"|"plain") -> pastel fill, sketch border, ink
 *     title, grey subtitle, in Nunito. With `layout:"flow"` + pill edges this reproduces a
 *     hand-tuned flow diagram from terse DSL. font:"excalifont" on style for a hand look.
 *   style: {stroke?,fill?,fillStyle?,rough?,font?} -- author with STANDARD Excalidraw
 *     LIGHT hexes (#1971c2/#e03131/#2f9e44/#1e1e1e + pale fills); the dark canvas inverts.
 *   data: rides to customData -> diagram-as-data, survives the round-trip.
 *
 * `layout:"flow"` (default) auto-lays edge-connected nodes top-down; `"free"` honours
 * each node's `at:[x,y]`. (You may also seed a RAW Excalidraw scene JSON instead, but
 * the DSL is the intended path.) Large seeds -> `contentUrl` (a blob URL holding it).
 *
 * ON SUBMIT, keyed by `id`:
 *   - DSL block: values[id] = { kind:"excalidraw", scene, diff, ... }
 *       scene = compact current-state DSL (positions/labels reflect the user's edits).
 *       diff  = { added, removed, moved, resized, relabeled }. `added` is the ANNOTATION
 *               LAYER: elements the user drew with NO dsl id (their comments/markup).
 *       Large -> { kind:"excalidraw-ref", url, scene, diff } (raw snapshot in the blob,
 *       scene+diff stay inline). To redraw in place, send an updated DSL Scene back as
 *       `content` via update_dialog -- it re-expands without a remount.
 *   - freehand / raw block: values[id] = { kind:"draw", snapshot, bytes } or
 *       { kind:"draw-ref", url, bytes } (fetch the url for the raw scene JSON).
 */
export interface DrawComponent {
  type: 'Draw'
  id: string
  /** Inline seed: a compact DSL `Scene` JSON string (or a raw Excalidraw scene). Mutually exclusive with contentUrl. */
  content?: string
  /** URL to a blob holding the seed JSON (large DSL Scenes / spilled drawings). */
  contentUrl?: string
  /** View-only: render the canvas but disable drawing/editing. */
  readOnly?: boolean
  /** Canvas height in px (default 420). */
  height?: number
  label?: string
}

export interface ImageComponent {
  type: 'Image'
  id?: string
  url: string
  alt?: string
}

export interface AlertComponent {
  type: 'Alert'
  id?: string
  intent?: AlertIntent
  content: string
}

export interface DividerComponent {
  type: 'Divider'
  id?: string
}

/**
 * An ISOLATED HTML embed: arbitrary HTML rendered inside a SANDBOXED iframe
 * (`allow-scripts` WITHOUT `allow-same-origin`), so it runs in an opaque origin
 * and can NEVER touch the control-panel origin, its cookies, or localStorage.
 * Zoomable to true-viewport fullscreen.
 *
 * Two source modes (mutually exclusive):
 *   - `content`: inline HTML string -> rendered via the iframe's `srcdoc`. Best for
 *     small, self-contained snippets (a chart, a styled table, a mini widget).
 *   - `url`: a URL to an HTML document -> the iframe's `src`. An http(s) URL passes
 *     through; a LOCAL path (relative to the dialog CWD) is uploaded to the blob
 *     store first and rewritten to its `/file/...` URL. Best for large documents or
 *     anything the agent already uploaded via `share_file`.
 */
export interface HtmlComponent {
  type: 'Html'
  id?: string
  /** Inline HTML string (rendered via iframe srcdoc). Mutually exclusive with url. */
  content?: string
  /** http(s) URL, or a local path (uploaded to the blob store). Mutually exclusive with content. */
  url?: string
  /** Iframe height in px (default 360). Fullscreen ignores this. */
  height?: number
  label?: string
}

// Rich plan blocks (display only, no result data) — shared by dialogs and
// visual plans. Each wraps an existing renderer (Markdown/Shiki fences) or a
// small structured view; heavy renderers travel in the lazy dialog chunk.

export interface DiffComponent {
  type: 'Diff'
  id?: string
  /** Unified diff text (rendered via a `diff` syntax fence). */
  content: string
  /** Optional file path / heading shown above the diff. */
  filename?: string
}

export type FileTreeStatus = 'added' | 'modified' | 'removed' | 'unchanged'

export interface FileTreeEntry {
  /** Slash-separated path; nesting is derived from the segments. */
  path: string
  status?: FileTreeStatus
  /** Optional short note shown to the right of the entry. */
  note?: string
}

export interface FileTreeComponent {
  type: 'FileTree'
  id?: string
  label?: string
  entries: FileTreeEntry[]
}

export interface DataModelField {
  name: string
  type: string
  note?: string
  status?: FileTreeStatus
}

export interface DataModelComponent {
  type: 'DataModel'
  id?: string
  /** Model / table name. */
  name: string
  fields: DataModelField[]
}

export interface ApiEndpointComponent {
  type: 'ApiEndpoint'
  id?: string
  method: string
  path: string
  description?: string
  /** Request body / params, shown as a JSON fence. */
  request?: string
  /** Response shape, shown as a JSON fence. */
  response?: string
}

export interface CodeAnnotation {
  /** 1-based line number the note points at. */
  line: number
  note: string
}

export interface AnnotatedCodeComponent {
  type: 'AnnotatedCode'
  id?: string
  code: string
  language?: string
  filename?: string
  annotations?: CodeAnnotation[]
}

// Input components (produce result data, keyed by `id`)

export interface OptionItem {
  value: string
  label: string
  description?: string
}

export interface OptionsComponent {
  type: 'Options'
  id: string
  label?: string
  multi?: boolean
  required?: boolean
  default?: string | string[]
  options: OptionItem[]
}

export interface TextInputComponent {
  type: 'TextInput'
  id: string
  label?: string
  placeholder?: string
  required?: boolean
  multiline?: boolean
  default?: string
  allowAttachment?: boolean
}

export interface ImagePickerImage {
  value: string
  url: string
  label?: string
}

export interface ImagePickerComponent {
  type: 'ImagePicker'
  id: string
  label?: string
  multi?: boolean
  allowUpload?: boolean
  images: ImagePickerImage[]
}

export interface ToggleComponent {
  type: 'Toggle'
  id: string
  label: string
  default?: boolean
}

export interface SliderComponent {
  type: 'Slider'
  id: string
  label?: string
  min?: number
  max?: number
  step?: number
  default?: number
}

// Action component

export interface ButtonComponent {
  type: 'Button'
  id: string
  label: string
  variant?: ButtonVariant
  intent?: ButtonIntent
  /** Live dialogs: bind a click to an agent round-trip / client-side action. */
  onClick?: EventHandler
}

// Layout components (structural, contain children)

export interface StackComponent {
  type: 'Stack'
  id?: string
  direction?: 'vertical' | 'horizontal'
  children: DialogComponent[]
}

export interface GridComponent {
  type: 'Grid'
  id?: string
  columns?: number
  children: DialogComponent[]
}

export interface GroupComponent {
  type: 'Group'
  id?: string
  label: string
  collapsed?: boolean
  children: DialogComponent[]
}

// ─── Component Union ───────────────────────────────────────────────

export type DialogComponent =
  | MarkdownComponent
  | DiagramComponent
  | DrawComponent
  | ImageComponent
  | AlertComponent
  | DividerComponent
  | HtmlComponent
  | DiffComponent
  | FileTreeComponent
  | DataModelComponent
  | ApiEndpointComponent
  | AnnotatedCodeComponent
  | OptionsComponent
  | TextInputComponent
  | ImagePickerComponent
  | ToggleComponent
  | SliderComponent
  | ButtonComponent
  | StackComponent
  | GridComponent
  | GroupComponent

// ─── Page & Layout ─────────────────────────────────────────────────

export interface DialogPage {
  label: string
  body: DialogComponent[]
}

export interface DialogLayout {
  title: string
  description?: string
  /** Opt-in width for larger designs (side-by-side, mermaid, multi-column). Default 'normal'. */
  width?: DialogWidth
  /** Live dialogue: persists, is reopenable, and is patched in place across turns. */
  persistent?: boolean
  timeout?: number // seconds, default 900, min 10, max 3600
  submitLabel?: string // default 'Submit'
  cancelLabel?: string // default 'Cancel'
  /** Live dialogue ONLY: a HARD-terminal second submit -- "this is my final
   *  decision, we're done." Renders next to the normal submit. Clicking it
   *  submits every field value (like submit) but ALSO carries `_final: true` and
   *  immediately closes the dialog client-side, so it stops the moment the user
   *  commits. The agent reads `_final` as "approved, do not reopen". Use it for an
   *  approval gate (e.g. "Approve all -- let's go" on a visual plan). Gated on the
   *  same required fields as submit. Ignored on one-shot (non-persistent) dialogs. */
  finalizeLabel?: string
  /** Optional one-click secondary submit. Unlike the footer cancel button
   *  (which dismisses with NO form values), this SUBMITS the dialog -- the
   *  result carries every field value plus `_action: id`. Use it for a real
   *  second outcome that needs the typed input (e.g. "Request changes" on a
   *  plan-approval dialog, where the feedback text must travel with reject).
   *  Renders as the left footer button, replacing plain cancel; the header X
   *  and backdrop still perform a pure dismiss. */
  secondaryAction?: { id: string; label: string; intent?: ButtonIntent }
  // Mutually exclusive: single-page (body) or multi-page (pages)
  body?: DialogComponent[]
  pages?: DialogPage[]
}

// ─── Result Schema ─────────────────────────────────────────────────

export interface DialogResult {
  [key: string]: unknown
  _action: string // 'submit' or custom button id
  _timeout: boolean
  _cancelled: boolean
}

// ─── WS Message Types ──────────────────────────────────────────────

/** Agent Host -> Broker: show dialog to dashboard */
export interface DialogShow {
  type: 'dialog_show'
  conversationId: string
  dialogId: string // unique per dialog invocation
  layout: DialogLayout
}

/** Dashboard -> Broker -> Agent Host: user submitted/cancelled/timed out */
export interface DialogResponse {
  type: 'dialog_result'
  conversationId: string
  dialogId: string
  result: DialogResult
}

/** Agent Host -> Broker -> Control Panel: dismiss active dialog */
export interface DialogDismiss {
  type: 'dialog_dismiss'
  conversationId: string
  dialogId: string
}

// ─── Validation ────────────────────────────────────────────────────

const VALID_COMPONENT_TYPES = new Set([
  'Markdown',
  'Diagram',
  'Draw',
  'Image',
  'Alert',
  'Divider',
  'Html',
  'Diff',
  'FileTree',
  'DataModel',
  'ApiEndpoint',
  'AnnotatedCode',
  'Options',
  'TextInput',
  'ImagePicker',
  'Toggle',
  'Slider',
  'Button',
  'Stack',
  'Grid',
  'Group',
])

const INPUT_COMPONENT_TYPES = new Set(['Options', 'TextInput', 'ImagePicker', 'Toggle', 'Slider', 'Button', 'Draw'])

/** Validate an DialogLayout, returns array of error messages (empty = valid) */
export function validateDialogLayout(layout: unknown): string[] {
  const errors: string[] = []
  if (!layout || typeof layout !== 'object') {
    return ['Layout must be an object']
  }

  const l = layout as Record<string, unknown>
  if (typeof l.title !== 'string' || !l.title) {
    errors.push('title is required and must be a non-empty string')
  }

  if (l.timeout !== undefined) {
    if (typeof l.timeout !== 'number' || l.timeout < 10 || l.timeout > 3600) {
      errors.push('timeout must be a number between 10 and 3600')
    }
  }

  const hasBody = Array.isArray(l.body)
  const hasPages = Array.isArray(l.pages)

  if (!hasBody && !hasPages) {
    errors.push('Either "body" or "pages" is required')
  } else if (hasBody && hasPages) {
    errors.push('Provide either "body" or "pages", not both')
  }

  if (hasBody) {
    const body = l.body as unknown[]
    if (body.length === 0) errors.push('body must have at least one component')
    const ids = new Set<string>()
    for (const comp of body) {
      validateComponent(comp, errors, ids, 0)
    }
  }

  if (hasPages) {
    const pages = l.pages as unknown[]
    if (pages.length === 0) errors.push('pages must have at least one page')
    const ids = new Set<string>()
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i] as Record<string, unknown>
      if (typeof page?.label !== 'string') {
        errors.push(`pages[${i}].label is required`)
      }
      if (!Array.isArray(page?.body) || (page.body as unknown[]).length === 0) {
        errors.push(`pages[${i}].body must be a non-empty array`)
      } else {
        for (const comp of page.body as unknown[]) {
          validateComponent(comp, errors, ids, 0)
        }
      }
    }
  }

  // Live/persistent extensions (width, persistent, inline handlers, stable ids).
  errors.push(...validateLiveExtensions(layout))

  return errors
}

const MAX_NESTING = 4

function validateComponent(comp: unknown, errors: string[], ids: Set<string>, depth: number): void {
  if (!comp || typeof comp !== 'object') {
    errors.push('Component must be an object')
    return
  }

  const c = comp as Record<string, unknown>
  const type = c.type as string
  if (!VALID_COMPONENT_TYPES.has(type)) {
    errors.push(`Unknown component type: "${type}"`)
    return
  }

  // Check for duplicate IDs
  if (INPUT_COMPONENT_TYPES.has(type) && typeof c.id === 'string') {
    if (ids.has(c.id)) {
      errors.push(`Duplicate component id: "${c.id}"`)
    }
    ids.add(c.id)
  }

  // Validate required fields per type
  switch (type) {
    case 'Markdown':
      if (typeof c.content !== 'string' && typeof c.file !== 'string') {
        errors.push('Markdown requires either "content" or "file"')
      }
      break
    case 'Diagram':
      if (typeof c.content !== 'string') errors.push('Diagram.content is required')
      break
    case 'Draw':
      if (typeof c.id !== 'string' || c.id === '') errors.push('Draw.id is required')
      if (c.content !== undefined && typeof c.content !== 'string') {
        errors.push('Draw.content must be a string (a DSL Scene or raw Excalidraw scene, JSON)')
      }
      if (c.contentUrl !== undefined && typeof c.contentUrl !== 'string') {
        errors.push('Draw.contentUrl must be a string URL')
      }
      if (c.height !== undefined && typeof c.height !== 'number') {
        errors.push('Draw.height must be a number')
      }
      break
    case 'Image':
      if (typeof c.url !== 'string') errors.push('Image.url is required')
      break
    case 'Alert':
      if (typeof c.content !== 'string') errors.push('Alert.content is required')
      break
    case 'Html': {
      const hasContent = typeof c.content === 'string'
      const hasUrl = typeof c.url === 'string'
      if (!hasContent && !hasUrl) errors.push('Html requires either "content" or "url"')
      if (hasContent && hasUrl) errors.push('Html: provide either "content" or "url", not both')
      if (c.height !== undefined && typeof c.height !== 'number') errors.push('Html.height must be a number')
      break
    }
    case 'Diff':
      if (typeof c.content !== 'string') errors.push('Diff.content is required')
      break
    case 'FileTree':
      if (!Array.isArray(c.entries) || (c.entries as unknown[]).length === 0) {
        errors.push('FileTree.entries must be a non-empty array')
      } else {
        ;(c.entries as unknown[]).forEach((e, i) => {
          if (!e || typeof e !== 'object' || typeof (e as Record<string, unknown>).path !== 'string') {
            errors.push(`FileTree.entries[${i}].path is required and must be a string`)
          }
        })
      }
      break
    case 'DataModel':
      if (typeof c.name !== 'string' || c.name === '') errors.push('DataModel.name is required')
      if (!Array.isArray(c.fields) || (c.fields as unknown[]).length === 0) {
        errors.push('DataModel.fields must be a non-empty array')
      } else {
        ;(c.fields as unknown[]).forEach((f, i) => {
          const fld = f as Record<string, unknown>
          if (!f || typeof f !== 'object' || typeof fld.name !== 'string') {
            errors.push(`DataModel.fields[${i}].name is required and must be a string`)
          } else if (typeof fld.type !== 'string') {
            errors.push(`DataModel.fields[${i}].type is required and must be a string`)
          }
        })
      }
      break
    case 'ApiEndpoint':
      if (typeof c.method !== 'string' || c.method === '') errors.push('ApiEndpoint.method is required')
      if (typeof c.path !== 'string' || c.path === '') errors.push('ApiEndpoint.path is required')
      break
    case 'AnnotatedCode':
      if (typeof c.code !== 'string') errors.push('AnnotatedCode.code is required')
      if (c.annotations !== undefined && !Array.isArray(c.annotations)) {
        errors.push('AnnotatedCode.annotations must be an array')
      }
      break
    case 'Options':
      if (typeof c.id !== 'string') errors.push('Options.id is required')
      if (!Array.isArray(c.options) || (c.options as unknown[]).length === 0) {
        errors.push('Options.options must be a non-empty array')
      } else {
        const seen = new Set<string>()
        ;(c.options as unknown[]).forEach((opt, i) => {
          if (!opt || typeof opt !== 'object') {
            errors.push(`Options.options[${i}] must be an object`)
            return
          }
          const o = opt as Record<string, unknown>
          // value is the identity of the choice -- without it every option
          // collapses to `undefined`, which the renderer reads as "all selected".
          if (typeof o.value !== 'string' || o.value === '') {
            errors.push(`Options.options[${i}].value is required and must be a non-empty string`)
          } else if (seen.has(o.value)) {
            errors.push(`Options.options[${i}].value "${o.value}" is duplicated`)
          } else {
            seen.add(o.value)
          }
          if (typeof o.label !== 'string' || o.label === '') {
            errors.push(`Options.options[${i}].label is required and must be a non-empty string`)
          }
        })
      }
      break
    case 'TextInput':
      if (typeof c.id !== 'string') errors.push('TextInput.id is required')
      break
    case 'ImagePicker':
      if (typeof c.id !== 'string') errors.push('ImagePicker.id is required')
      if (!Array.isArray(c.images) || (c.images as unknown[]).length === 0) {
        errors.push('ImagePicker.images must be a non-empty array')
      } else {
        const seen = new Set<string>()
        ;(c.images as unknown[]).forEach((img, i) => {
          if (!img || typeof img !== 'object') {
            errors.push(`ImagePicker.images[${i}] must be an object`)
            return
          }
          const im = img as Record<string, unknown>
          if (typeof im.value !== 'string' || im.value === '') {
            errors.push(`ImagePicker.images[${i}].value is required and must be a non-empty string`)
          } else if (seen.has(im.value)) {
            errors.push(`ImagePicker.images[${i}].value "${im.value}" is duplicated`)
          } else {
            seen.add(im.value)
          }
          if (typeof im.url !== 'string' || im.url === '') {
            errors.push(`ImagePicker.images[${i}].url is required and must be a non-empty string`)
          }
        })
      }
      break
    case 'Toggle':
      if (typeof c.id !== 'string') errors.push('Toggle.id is required')
      if (typeof c.label !== 'string') errors.push('Toggle.label is required')
      break
    case 'Slider':
      if (typeof c.id !== 'string') errors.push('Slider.id is required')
      break
    case 'Button':
      if (typeof c.id !== 'string') errors.push('Button.id is required')
      if (typeof c.label !== 'string') errors.push('Button.label is required')
      break
  }

  // Validate children for layout components
  if (type === 'Stack' || type === 'Grid' || type === 'Group') {
    if (depth >= MAX_NESTING) {
      errors.push(`Maximum nesting depth (${MAX_NESTING}) exceeded`)
      return
    }
    if (type === 'Group' && typeof c.label !== 'string') {
      errors.push('Group.label is required')
    }
    if (!Array.isArray(c.children)) {
      errors.push(`${type}.children is required and must be an array`)
    } else {
      for (const child of c.children as unknown[]) {
        validateComponent(child, errors, ids, depth + 1)
      }
    }
  }
}

// ─── MCP Tool Input Schema (JSON Schema for Claude) ────────────────

/**
 * Generate the JSON Schema representation for the MCP tool input.
 * This is what Claude sees in the tool definition.
 */
export function dialogToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Dialog title (required)' },
      description: { type: 'string', description: 'Optional subtitle/context (markdown)' },
      width: {
        type: 'string',
        enum: ['normal', 'wide', 'full'],
        description:
          "Opt-in width for larger designs. 'normal' (default) for forms/choices; 'wide' for side-by-side comparisons, mermaid diagrams, or multi-column block layouts; 'full' for the largest designs.",
      },
      persistent: {
        type: 'boolean',
        description:
          'Make this a LIVE dialog that survives across turns instead of a one-shot. The user interacts locally (instant, no agent turns) and hits one "Send to agent" button; you receive the full form state in ONE turn and patch the dialog in place with update_dialog(dialogId, ops) -- it stays open. Reopen a closed one with reopen_dialog. Use ONLY when the artifact must persist AND you will re-derive content from interaction (e.g. comment-on-a-design -> redraw); for plain multi-step collection use "pages" (instant). Every block MUST have a stable "id" so patches reconcile without losing input. KEEP IT SMALL across its life: as topics resolve, removePage the tabs that no longer matter so the user only ever sees the live part; and the moment it is RESOLVED, close it with close_dialog -- never leave a resolved dialog open. ALWAYS USE "pages" (NOT "body") for live dialogs: each page renders as a TAB the user clicks between -- much better than a tall column they must SCROLL. Split distinct sections (plan vs files vs risks, or step 1 vs step 2) into pages. Tab lifecycle ops for update_dialog: setPage(page) focuses a tab, addPage(label,body,after?) adds a new tab, removePage(page) removes a resolved tab, replacePage(page,label?,body?) replaces a tab\'s content. After patching blocks on a tab, always include setPage to focus the changed tab so the user sees it.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default 900, min 10, max 3600). Ignored when persistent (no timeout).',
      },
      submitLabel: { type: 'string', description: 'Submit button label (default "Submit")' },
      cancelLabel: { type: 'string', description: 'Cancel button label (default "Cancel")' },
      finalizeLabel: {
        type: 'string',
        description:
          'Live (persistent) dialog only: label for a HARD-terminal "final decision" submit (e.g. "Approve all -- let\'s go"). Renders beside submit. Submits every field value, marks the result _final:true, and immediately closes the dialog so it stops the moment the user commits. Use for an approval gate; omit if there is no final-approval outcome.',
      },
      body: {
        type: 'array',
        description:
          'Single-page layout. Array of components. Mutually exclusive with "pages". Component types: Markdown (content OR file -- use file to reference a local path instead of inlining text, saves context tokens; color?), Diagram (content, id?, commentable? -- live dialogs: with id+commentable the user clicks a node to attach a note; notes arrive as values[id]={nodeId:note}, redraw to address them), Draw (id, content?, contentUrl?, readOnly?, height?, label? -- an INTERACTIVE WHITEBOARD canvas powered by Excalidraw; the user draws/edits/annotates and submits the result back. SEED it via content with a COMPACT agent shapes DSL Scene JSON string -- you author SHAPES, not raw elements, and the client expands them (layout + bound arrows + sketchy UI macros) so you do NO pixel math. Scene = {v:1,layout?:"flow"|"free",nodes:[...],edges?:[...]}. nodes (id addressable for the diff): {id,kind:"box"|"ellipse"|"diamond",text?,title?,subtitle?,variant?,w?,h?,style?,data?} | {kind:"text",text,size?} | {id,kind:"button",text,variant?} | {id,kind:"input",label?,placeholder?} | {id,kind:"checkbox",text,checked?} | {id,kind:"card"|"screen",title?,children:[...]} | {id,kind:"nav",items:[...]} | {id,kind:"image",url}. layout containers (do the geometry, you only nest): {kind:"row"|"col",gap?,align?,children:[...]} | {kind:"grid",cols,gap?,children:[...]}. edges bind arrows by node id: {from,to,text?,arrow?:"->"|"<->"|"--",dashed?} (an edge text renders as a white pill chip on the connector). SCHEME look (polished cards): a box with title+subtitle+variant ("blue"|"gold"|"green"|"rose"|"steel"|"plain") becomes a pastel sketch-border card with an ink title + grey Nunito subtitle; layout:"flow" + pill edges reproduces a hand-tuned flow diagram from terse DSL. style.stroke/fill: use STANDARD Excalidraw LIGHT hexes (#1971c2/#e03131/#2f9e44 + pale fills), the dark canvas inverts. node.data rides to customData (diagram-as-data, survives round-trip). layout:"flow" auto-lays edge graphs top-down; "free" uses each node "at":[x,y]. Large seed -> contentUrl. ON SUBMIT values[id]={kind:"excalidraw",scene,diff} (large: {kind:"excalidraw-ref",url,scene,diff}): scene=compact current-state DSL with the user moves/relabels applied; diff={added,removed,moved,resized,relabeled} where ADDED is the annotation layer = elements the user drew with no dsl id (their comments). To redraw in place, send an updated Scene back as content via update_dialog (re-expands, no remount). A freehand/raw block instead returns {kind:"draw",snapshot,bytes}/{kind:"draw-ref",url,bytes}. Best in a persistent dialog with width "wide"/"full"; the /canvas skill teaches the loop. For RAW-element authoring beyond the macros (exact element fields, enums, bindings, the dark-mode palette + other gotchas, validated example scenes), call dialog_taxonomy("draw")), Image (url, alt?), Alert (intent?: info|warning|error|success, content), Divider, Html (content OR url, height?, label? -- an ISOLATED HTML embed rendered in a SANDBOXED iframe (allow-scripts, NO same-origin: opaque origin, cannot touch the control panel/cookies), zoomable to fullscreen. content = inline HTML string (srcdoc, for small self-contained snippets); url = http(s) URL or a LOCAL path that gets uploaded to the blob store (for large docs / anything from share_file). Use it for a rich custom visual the block set cannot express -- a chart, a styled report, an interactive widget), Diff (content: unified diff text, filename?), FileTree (entries[{path, status?: added|modified|removed|unchanged, note?}], label?), DataModel (name, fields[{name, type, note?, status?}]), ApiEndpoint (method, path, description?, request?: JSON string, response?: JSON string), AnnotatedCode (code, language?, filename?, annotations[{line, note}]), Options (id, options[{value,label,description?}], label?, multi?, required?, default?), TextInput (id, label?, placeholder?, required?, multiline?, default?), ImagePicker (id, images[{value,url,label?}], label?, multi?, allowUpload?), Toggle (id, label, default?), Slider (id, label?, min?, max?, step?, default?), Button (id, label, variant?: default|primary|outline|ghost, intent?: neutral|destructive|success), Stack (direction?: vertical|horizontal, children[]), Grid (columns?, children[]), Group (label, collapsed?, children[]). Colors: primary|secondary|muted|accent|destructive|success|warning|info. All text/label fields support markdown.',
        items: { type: 'object' },
      },
      pages: {
        type: 'array',
        description:
          'Multi-page layout. Array of {label, body: [...components]}. Renderer handles navigation (tabs/stepper). Last page shows submit. Mutually exclusive with "body". STRONGLY PREFERRED over one long scrolling body whenever a dialog has distinct sections -- each page is a TAB, so the user jumps instead of scrolling (scrolling is bad UX). In a LIVE (persistent) dialog the pages render as tabs and you move the focused tab from the agent side with the setPage op (update_dialog) -- e.g. drop the user straight on the page you just patched.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Page tab/step label' },
            body: { type: 'array', description: 'Array of components (same types as body)', items: { type: 'object' } },
          },
          required: ['label', 'body'],
        },
      },
    },
    required: ['title'],
  }
}
