/**
 * THE DIALOGUE — live/persistent dialog extensions to the base dialog schema.
 *
 * Kept in its own module so the base `dialog-schema.ts` stays a flat declaration
 * surface and its baselined validators aren't disturbed. These additions are
 * opt-in: a layout without `persistent` behaves exactly like today's one-shot
 * dialog.
 *
 * D1a scope: TYPES + validation only. Wire messages (dialog_patch / dialog_event
 * / dialog_orphaned) and behavior land in D1b/D1c.
 */
// Opt-in width for larger designs (side-by-side, mermaid, multi-column).
export type DialogWidth = 'normal' | 'wide' | 'full'
const DIALOG_WIDTHS = new Set<string>(['normal', 'wide', 'full'])

// Inline event binding declared ON the element that emits it. The caller-chosen
// `id` is the correlation mnemonic the agent maps an event back to.
export type EventAction = 'agent' | 'navigate' | 'close'
export interface EventHandler {
  action: EventAction
  id: string // caller mnemonic; must not start with '_' (reserved namespace)
  debounce?: number // ms (change handlers)
  to?: string // client-side nav target (action: 'navigate')
}
const EVENT_ACTIONS = new Set<string>(['agent', 'navigate', 'close'])

// (Patch op types — DialogOp — land in D1b with the update_dialog tool that
// consumes them.)

// ─── Validation (small, single-purpose helpers) ────────────────────

function eachComponent(comps: unknown, visit: (c: Record<string, unknown>) => void): void {
  if (!Array.isArray(comps)) return
  for (const raw of comps) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    visit(c)
    if (Array.isArray(c.children)) eachComponent(c.children, visit)
  }
}

function topLevel(layout: Record<string, unknown>): unknown[] {
  if (Array.isArray(layout.body)) return layout.body
  if (Array.isArray(layout.pages)) {
    return (layout.pages as Array<Record<string, unknown>>).flatMap(p => (Array.isArray(p?.body) ? p.body : []))
  }
  return []
}

function validateHandlerId(id: unknown, slot: string, errors: string[]): void {
  if (typeof id !== 'string' || id === '') {
    errors.push(`${slot}.id is required and must be a non-empty string`)
  } else if (id.startsWith('_')) {
    errors.push(`${slot}.id "${id}" must not start with '_' (reserved)`)
  }
}

function validateHandler(c: Record<string, unknown>, slot: 'onClick' | 'onChange', errors: string[]): void {
  const h = c[slot]
  if (h === undefined) return
  if (!h || typeof h !== 'object') {
    errors.push(`${slot} must be an object`)
    return
  }
  const eh = h as Record<string, unknown>
  const validAction = typeof eh.action === 'string' && EVENT_ACTIONS.has(eh.action)
  if (!validAction) errors.push(`${slot}.action must be one of agent|navigate|close`)
  validateHandlerId(eh.id, slot, errors)
  const badDebounce = eh.debounce !== undefined && typeof eh.debounce !== 'number'
  if (badDebounce) errors.push(`${slot}.debounce must be a number`)
}

/**
 * Validate the live/persistent extensions. Returns error strings (empty = ok).
 * Called once from validateDialogLayout — adds no branching to that function.
 */
export function validateLiveExtensions(layout: unknown): string[] {
  if (!layout || typeof layout !== 'object') return []
  const l = layout as Record<string, unknown>
  const errors: string[] = []

  if (l.width !== undefined && (typeof l.width !== 'string' || !DIALOG_WIDTHS.has(l.width))) {
    errors.push('width must be one of normal|wide|full')
  }

  const persistent = l.persistent === true
  const seenIds = new Set<string>()
  eachComponent(topLevel(l), c => {
    validateHandler(c, 'onClick', errors)
    validateHandler(c, 'onChange', errors)
    const id = c.id
    if (typeof id === 'string' && id !== '') {
      if (seenIds.has(id)) errors.push(`duplicate block id: "${id}"`)
      seenIds.add(id)
    } else if (persistent) {
      errors.push(`persistent dialog requires a stable id on every block (missing on a ${String(c.type)})`)
    }
  })

  return errors
}
