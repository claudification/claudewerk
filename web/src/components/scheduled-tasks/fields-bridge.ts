/**
 * The adapter between a schedule's spawn snapshot and `LaunchConfigFields`.
 *
 * This is what lets the editor reuse the spawn dialog's launch controls verbatim
 * instead of growing a parallel copy that drifts. Both sides speak the partial
 * spawn shape; this only translates the "" vs undefined convention -- the form
 * uses empty strings, the wire wants fields absent when there is no override.
 *
 * Table-driven rather than a wall of `if ('x' in patch)`: one row per field, so
 * adding a launch control is a line here instead of another branch.
 */

import type { LaunchFieldsValue } from '../launch-config-fields'
import type { ScheduleDraft } from './use-schedule-draft'

type Spawn = ScheduleDraft['spawn']

/** Empty string / undefined both mean "no override". */
const asText = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? undefined : s
}

const asNumber = (v: unknown): number | undefined => {
  if (v === '' || v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * One row per field the editor exposes: how to read it out of the spawn snapshot
 * for the form, and how to write a form value back.
 */
const FIELD_MAP: Array<{
  key: keyof LaunchFieldsValue
  read: (spawn: Spawn) => LaunchFieldsValue[keyof LaunchFieldsValue]
  write: (spawn: Spawn, value: unknown) => void
}> = [
  {
    key: 'model',
    read: s => s.model ?? '',
    write: (s, v) => {
      s.model = asText(v) as Spawn['model']
    },
  },
  {
    key: 'effort',
    read: s => s.effort ?? '',
    write: (s, v) => {
      s.effort = asText(v) as Spawn['effort']
    },
  },
  {
    key: 'agent',
    read: s => s.agent ?? '',
    write: (s, v) => {
      s.agent = asText(v)
    },
  },
  {
    key: 'permissionMode',
    read: s => s.permissionMode ?? '',
    write: (s, v) => {
      s.permissionMode = asText(v) as Spawn['permissionMode']
    },
  },
  {
    key: 'maxBudgetUsd',
    read: s => (s.maxBudgetUsd ? String(s.maxBudgetUsd) : ''),
    write: (s, v) => {
      s.maxBudgetUsd = asNumber(v)
    },
  },
  {
    key: 'autocompactPct',
    read: s => s.autocompactPct ?? '',
    write: (s, v) => {
      s.autocompactPct = asNumber(v)
    },
  },
  {
    key: 'headless',
    read: s => s.headless ?? true,
    write: (s, v) => {
      s.headless = Boolean(v)
    },
  },
  {
    key: 'worktreeName',
    read: s => s.worktree ?? '',
    write: (s, v) => {
      s.worktree = asText(v)
    },
  },
  {
    // The checkbox only ever CLEARS -- the name field is what sets a branch.
    key: 'useWorktree',
    read: s => Boolean(s.worktree),
    write: (s, v) => {
      if (!v) s.worktree = undefined
    },
  },
]

export function toFieldsValue(draft: ScheduleDraft): LaunchFieldsValue {
  const value: Record<string, unknown> = { envText: '' }
  for (const field of FIELD_MAP) value[field.key] = field.read(draft.spawn)
  return value as LaunchFieldsValue
}

/** Apply a form patch back onto the draft, dropping empties. */
export function applyFieldsPatch(draft: ScheduleDraft, patch: Partial<LaunchFieldsValue>): ScheduleDraft {
  const spawn = { ...draft.spawn }
  for (const field of FIELD_MAP) {
    if (field.key in patch) field.write(spawn, patch[field.key])
  }
  return { ...draft, spawn }
}
