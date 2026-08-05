import { CARD_DESCRIBERS } from './describe-cards'
import { CORE_DESCRIBERS } from './describe-core'
import { ERROR_DESCRIBERS } from './describe-errors'
import { TASK_DESCRIBERS } from './describe-tasks'
import { VCS_DESCRIBERS } from './describe-vcs'
import type { SystemDescriber, SystemEntry, SystemEntryResult } from './types'
import { str } from './types'

/**
 * One describer per CC `type: "system"` subtype, split by theme so no single
 * file owns the whole catalog. Keys are CC's wire subtypes verbatim.
 *
 * CC ships new subtypes ahead of us -- `describeSystemEntry` falls back to
 * `content || [subtype]` rather than dropping the entry, so an unknown event
 * still shows up in the timeline (with its full payload one click away in the
 * JsonInspector). That fallback is the signal to come add an arm here.
 */
const SYSTEM_DESCRIBERS: Record<string, SystemDescriber> = {
  ...CORE_DESCRIBERS,
  ...ERROR_DESCRIBERS,
  ...TASK_DESCRIBERS,
  ...VCS_DESCRIBERS,
  ...CARD_DESCRIBERS,
}

export function describeSystemEntry(
  subtype: string,
  entry: SystemEntry,
  ts?: string | number,
): SystemEntryResult | null {
  const describer = SYSTEM_DESCRIBERS[subtype]
  if (describer) return describer(entry, ts)
  return { kind: 'text', text: str(entry.content) || `[${subtype}]`, color: 'text-muted-foreground' }
}

export type { SystemEntry, SystemEntryResult, TextResult } from './types'
