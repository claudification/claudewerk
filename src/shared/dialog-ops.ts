/**
 * THE DIALOGUE — pure op grammar: validate + apply.
 *
 * Both pieces are host-agnostic and side-effect-free so the host (authoritative
 * snapshot) and, later, the renderer (visible reconciliation) apply the SAME
 * semantics. `applyDialogOps` never mutates its input — it clones, applies what
 * it can, and reports everything it couldn't (`conflicts`) so the agent is never
 * silently clobbered (red-team must-fix R1#2/#4).
 */

import { ACTIVE_PAGE_KEY, type DialogOp, type DialogSnapshot, type DialogStatus } from './dialog-live'
import type { DialogComponent, DialogLayout, DialogPage } from './dialog-schema'
import { childrenOf, insertAfter, removeById, replaceById, rootArrays } from './dialog-tree'

// ─── Validation (shape only; target resolution happens in applyDialogOps) ──

type Op = Record<string, unknown>

function reqString(op: Op, field: string, at: string): string[] {
  return typeof op[field] !== 'string' || op[field] === '' ? [`${at}.${field} is required`] : []
}

function reqBlock(op: Op, at: string): string[] {
  const b = op.block
  const okBlock = !!b && typeof b === 'object' && typeof (b as Op).type === 'string'
  return okBlock ? [] : [`${at}.block must be a component with a string type`]
}

function validateAppend(op: Op, at: string): string[] {
  const errs = reqBlock(op, at)
  if (op.after !== undefined && typeof op.after !== 'string') errs.push(`${at}.after must be a string`)
  if (op.into !== undefined && typeof op.into !== 'string') errs.push(`${at}.into must be a string`)
  if (op.after !== undefined && op.into !== undefined) errs.push(`${at} cannot set both after and into`)
  return errs
}

// One validator per op kind; the dispatch is a single map lookup.
function validatePageTarget(op: Op, at: string): string[] {
  return typeof op.page === 'number' || (typeof op.page === 'string' && op.page !== '')
    ? []
    : [`${at}.page must be a number (index) or non-empty string (label)`]
}

const OP_VALIDATORS: Record<string, (op: Op, at: string) => string[]> = {
  replace: (op, at) => [...reqString(op, 'id', at), ...reqBlock(op, at)],
  append: validateAppend,
  remove: (op, at) => reqString(op, 'id', at),
  setState: (op, at) => reqString(op, 'key', at),
  unsetState: (op, at) => reqString(op, 'key', at),
  setPage: (op, at) => validatePageTarget(op, at),
  busy: (op, at) => (typeof op.pending !== 'boolean' ? [`${at}.pending must be a boolean`] : []),
  close: () => [],
  addPage: (op, at) => {
    const errs = reqString(op, 'label', at)
    if (!Array.isArray(op.body)) errs.push(`${at}.body must be an array`)
    if (op.after !== undefined && typeof op.after !== 'number' && typeof op.after !== 'string')
      errs.push(`${at}.after must be a number or string`)
    return errs
  },
  removePage: (op, at) => validatePageTarget(op, at),
  replacePage: (op, at) => {
    const errs = validatePageTarget(op, at)
    if (op.label !== undefined && typeof op.label !== 'string') errs.push(`${at}.label must be a string`)
    if (op.body !== undefined && !Array.isArray(op.body)) errs.push(`${at}.body must be an array`)
    return errs
  },
}

/** Validate an op list. Returns error strings (empty = ok). */
export function validateDialogOps(ops: unknown): string[] {
  if (!Array.isArray(ops)) return ['ops must be an array']
  if (ops.length === 0) return ['ops must not be empty']
  const errors: string[] = []
  ops.forEach((raw, i) => {
    const at = `ops[${i}]`
    if (!raw || typeof raw !== 'object') {
      errors.push(`${at} must be an object`)
      return
    }
    const op = raw as Op
    const validate = OP_VALIDATORS[String(op.op)]
    if (!validate) errors.push(`${at}.op "${String(op.op)}" is not a valid op`)
    else errors.push(...validate(op, at))
  })
  return errors
}

// ─── Application (pure tree edits over a cloned snapshot) ───────────

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface OpConflict {
  index: number
  op: DialogOp
  reason: string
}

export interface ApplyResult {
  layout: DialogLayout
  state: Record<string, unknown>
  status: DialogStatus
  applied: number
  conflicts: OpConflict[]
}

type StructuralOp = Extract<DialogOp, { op: 'replace' | 'remove' | 'append' }>
type ValueOp = Extract<DialogOp, { op: 'setState' | 'unsetState' | 'setPage' | 'busy' | 'close' }>
type PageOp = Extract<DialogOp, { op: 'addPage' | 'removePage' | 'replacePage' }>

/** Resolve a page target (index or label) to the array index, or -1. */
function resolvePageIdx(pages: DialogPage[], target: number | string): number {
  if (typeof target === 'number') return target >= 0 && target < pages.length ? target : -1
  const exact = pages.findIndex(p => p.label === target)
  if (exact >= 0) return exact
  const lower = target.toLowerCase()
  return pages.findIndex(p => p.label.toLowerCase() === lower)
}

function applyStructural(op: StructuralOp, roots: DialogComponent[][]): boolean {
  if (op.op === 'replace') return roots.some(r => replaceById(r, op.id, op.block))
  if (op.op === 'remove') return roots.some(r => removeById(r, op.id))
  // op is the append variant here
  if (op.into !== undefined) {
    for (const r of roots) {
      const into = childrenOf(r, op.into)
      if (into) {
        into.push(op.block)
        return true
      }
    }
    return false
  }
  if (op.after !== undefined) return roots.some(r => insertAfter(r, op.after as string, op.block))
  const first = roots[0]
  if (!first) return false
  first.push(op.block)
  return true
}

function structuralTarget(op: StructuralOp): string {
  const id = op.op === 'append' ? (op.into ?? op.after ?? '(root)') : op.id
  return `no block with id "${id}"`
}

/** Apply a value/lifecycle op to `state` in place. Returns whether it applied,
 *  any conflict reason, and any status override (close). */
function applyValueOp(
  op: ValueOp,
  state: Record<string, unknown>,
): { applied: boolean; conflict?: string; status?: DialogStatus } {
  switch (op.op) {
    case 'setState':
      if (op.expect !== undefined && !sameValue(state[op.key], op.expect)) {
        return { applied: false, conflict: `field "${op.key}" changed since the agent last saw it` }
      }
      state[op.key] = op.value
      return { applied: true }
    case 'unsetState':
      delete state[op.key]
      return { applied: true }
    case 'setPage':
      // Focus is panel-rendered but host-authoritative: park it in the reserved
      // state key so it persists in the snapshot + replays on reconnect.
      state[ACTIVE_PAGE_KEY] = op.page
      return { applied: true }
    case 'busy':
      // Transient wait-screen hint for the panel — not folded into the snapshot.
      return { applied: true }
    case 'close':
      return { applied: true, status: 'closed' }
  }
}

// fallow-ignore-next-line complexity
function applyPageOp(op: PageOp, layout: DialogLayout): true | string {
  if (!layout.pages) return 'layout has no pages (use body->pages migration first)'
  const pages = layout.pages
  if (op.op === 'addPage') {
    const newPage: DialogPage = { label: op.label, body: op.body }
    if (op.after !== undefined) {
      const idx = resolvePageIdx(pages, op.after)
      if (idx < 0) return `addPage: target page "${op.after}" not found`
      pages.splice(idx + 1, 0, newPage)
    } else {
      pages.push(newPage)
    }
    return true
  }
  if (op.op === 'removePage') {
    const idx = resolvePageIdx(pages, op.page)
    if (idx < 0) return `removePage: page "${op.page}" not found`
    if (pages.length <= 1) return 'removePage: cannot remove the last page'
    pages.splice(idx, 1)
    return true
  }
  // replacePage
  const idx = resolvePageIdx(pages, op.page)
  if (idx < 0) return `replacePage: page "${op.page}" not found`
  if (op.label !== undefined) pages[idx].label = op.label
  if (op.body !== undefined) pages[idx].body = op.body
  return true
}

/**
 * Apply ops to a snapshot. Returns a NEW layout/state (input untouched), the
 * resulting status, how many ops applied, and per-op conflicts for everything
 * that couldn't (missing target id, compare-and-swap mismatch). The seq bump is
 * the caller's (registry) job -- this stays pure.
 */
export function applyDialogOps(snapshot: DialogSnapshot, ops: DialogOp[]): ApplyResult {
  const layout = structuredClone(snapshot.layout)
  const state = structuredClone(snapshot.state) as Record<string, unknown>
  let status: DialogStatus = snapshot.status
  let applied = 0
  const conflicts: OpConflict[] = []
  const roots = rootArrays(layout)

  // fallow-ignore-next-line complexity
  ops.forEach((op, index) => {
    if (op.op === 'replace' || op.op === 'remove' || op.op === 'append') {
      if (applyStructural(op, roots)) applied++
      else conflicts.push({ index, op, reason: structuralTarget(op) })
      return
    }
    if (op.op === 'addPage' || op.op === 'removePage' || op.op === 'replacePage') {
      const res = applyPageOp(op, layout)
      if (res === true) applied++
      else conflicts.push({ index, op, reason: res })
      return
    }
    const res = applyValueOp(op, state)
    if (res.status) status = res.status
    if (res.conflict) conflicts.push({ index, op, reason: res.conflict })
    else if (res.applied) applied++
  })

  return { layout, state, status, applied, conflicts }
}
