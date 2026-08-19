/**
 * Turn a rendered transcript group into the boundary a point-in-time fork cuts at.
 *
 * The FIRST entry of the group is the boundary: a group is one turn, and "fork at
 * this message" means at where the turn starts, not where its tool churn ends.
 *
 * `uuid` is best-effort on purpose. Assistant rows carry a real CC uuid
 * essentially always; user rows about 91% of the time (voice-dictated and
 * system-reminder-wrapped prompts diverge from their file row); rclaude's own
 * chrome carries none. The timestamp travels alongside so the sentinel can still
 * place the cut when the uuid misses -- see src/shared/fork-cut.ts.
 */

import type { ForkPointSeed } from '../fork-dialog/fork-point'
import { previewText } from '../fork-dialog/fork-point'
import type { RenderItem } from './group-view-types'
import type { DisplayGroup } from './grouping'

/**
 * Only a real turn is a cut point. An ALLOW-list rather than a deny-list on
 * purpose: the group union also carries dividers and synthetic items (`live`,
 * `scrollback_spacer`, `compacted`, `skill`, `forked`, plus the chrome types),
 * and a deny-list silently starts offering the menu on whatever gets added next.
 */
const FORKABLE_GROUPS = new Set(['user', 'assistant'])

export function canForkAtGroup(group: DisplayGroup): boolean {
  return FORKABLE_GROUPS.has(group.type)
}

/** Flatten whatever the group renders into one plain-text preview line. */
function groupPreview(items: RenderItem[]): string {
  const parts: string[] = []
  for (const it of items) {
    if (it.kind === 'text') parts.push(it.text)
    else if (it.kind === 'bash') parts.push(it.text)
    else if (it.kind === 'tool') {
      const name = (it.tool as { name?: string }).name
      if (name) parts.push(`[${name}]`)
    }
    if (parts.join(' ').length > 400) break
  }
  return previewText(parts.join(' '))
}

export function buildForkPointSeed(group: DisplayGroup, items: RenderItem[]): ForkPointSeed | null {
  if (!canForkAtGroup(group)) return null

  const first = group.entries[0] as { uuid?: unknown; timestamp?: unknown } | undefined
  const uuid = typeof first?.uuid === 'string' && first.uuid ? first.uuid : undefined
  const timestamp = typeof first?.timestamp === 'string' && first.timestamp ? first.timestamp : undefined
  // Nothing to locate the boundary by. Offering the menu would produce a fork
  // from HEAD while looking like a cut, so the caller hides it instead.
  if (!uuid && !timestamp) return null

  return {
    uuid,
    timestamp,
    role: group.type === 'user' ? 'user' : 'assistant',
    preview: groupPreview(items),
  }
}
