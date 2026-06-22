/**
 * Dialog form-state seeding + required-field helpers. Shared by the one-shot
 * modal and the persistent inline renderer so both derive defaults + validate
 * required fields identically (no duplicated traversal).
 */
import type { DialogOp } from '@shared/dialog-live'
import type { DialogComponent, DialogLayout } from './types'

/** The default value an input block seeds, or null for non-inputs. */
function leafDefault(comp: DialogComponent): { id: string; value: unknown } | null {
  switch (comp.type) {
    case 'Options':
    case 'TextInput':
      return comp.default !== undefined ? { id: comp.id, value: comp.default } : null
    case 'Toggle':
      return { id: comp.id, value: comp.default ?? false }
    case 'Slider':
      return { id: comp.id, value: comp.default ?? comp.min ?? 0 }
    default:
      return null
  }
}

/** Seed form values from component defaults (recursively). */
function collectDefaults(components: DialogComponent[], values: Record<string, unknown>): void {
  for (const comp of components) {
    const leaf = leafDefault(comp)
    if (leaf) values[leaf.id] = leaf.value
    if ('children' in comp) collectDefaults(comp.children, values)
  }
}

/** All default values for a layout (single body or multi-page). */
export function getInitialValues(layout: DialogLayout): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  if (layout.body) collectDefaults(layout.body, values)
  else if (layout.pages) for (const page of layout.pages) collectDefaults(page.body, values)
  return values
}

/** Ids of required input fields (recursively). */
export function collectRequired(components: DialogComponent[]): string[] {
  const ids: string[] = []
  for (const comp of components) {
    if ('required' in comp && comp.required && 'id' in comp) ids.push(comp.id)
    if ('children' in comp) ids.push(...collectRequired(comp.children))
  }
  return ids
}

/**
 * Merge a host patch into the current input values: seed defaults for any NEW
 * blocks the patch introduced, keep everything the user already typed, then
 * apply the agent's explicit setState/unsetState ops. Shared by the form hook
 * (mounted, prop-driven) and the live-dialog store (so values stay correct even
 * while the dialog is unmounted on another conversation). Existing user input is
 * never clobbered by a structural patch -- only an explicit setState changes it.
 */
export function reconcileValues(
  prev: Record<string, unknown>,
  layout: DialogLayout,
  ops: DialogOp[],
): Record<string, unknown> {
  const next = { ...getInitialValues(layout), ...prev }
  for (const op of ops) {
    if (op.op === 'setState') next[op.key] = op.value
    else if (op.op === 'unsetState') delete next[op.key]
  }
  return next
}

export function hasValue(val: unknown): boolean {
  if (val === undefined || val === null || val === '') return false
  if (Array.isArray(val)) return val.length > 0
  return true
}
