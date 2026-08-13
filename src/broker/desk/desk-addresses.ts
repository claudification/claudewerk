/**
 * Canonical `project:conversation` addresses for the desk's view of the fleet.
 *
 * The desk toolset hands the orb RAW conversation ids (`read_transcript` needs
 * one, and they are stable). But a raw id is not something a human says out
 * loud, and it is not something a subscription can be expressed in -- so every
 * desk row also carries the canonical address from
 * shared/conversation-address.ts. Same conversation, two handles, each for what
 * it is good at: the id to READ it, the address to NAME it.
 *
 * Built in one pass over the fleet because the conversation half is
 * collision-aware: whether `nightshift` needs its `-a1b2c3` suffix depends on
 * its siblings, so addressing one conversation means grouping them all.
 */

import { matchesAnyPattern } from '../../shared/conversation-address'
import { projectIdentityKey } from '../../shared/project-uri'
import { type ConversationLike, conversationAddress } from '../conversation-address'
import { listDeskProjects } from './projects'

/** Stored label per project identity key, for the project half of the address. */
function labelIndex(): Map<string, string> {
  return new Map(listDeskProjects().map(p => [p.key, p.label]))
}

/** The project identity key for a conversation, or null when it has no project. */
function keyOf(project: string | null | undefined): string | null {
  if (!project) return null
  try {
    return projectIdentityKey(project)
  } catch {
    return null
  }
}

/**
 * Address every conversation in one pass: `conversationId -> project:conversation`.
 * Conversations with no project are skipped -- there is nothing to address them
 * under, and inventing a project half would produce a name that matches nothing.
 */
export function addressFleet(
  conversations: readonly ConversationLike[],
  now: number = Date.now(),
): Map<string, string> {
  const labels = labelIndex()
  const byProject = new Map<string, ConversationLike[]>()
  for (const c of conversations) {
    const key = keyOf(c.project)
    if (!key) continue
    const group = byProject.get(key)
    if (group) group.push(c)
    else byProject.set(key, [c])
  }

  const out = new Map<string, string>()
  for (const [key, group] of byProject) {
    const label = labels.get(key) ?? null
    for (const c of group) out.set(c.id, conversationAddress(c, group, label, now))
  }
  return out
}

/** Every live address matching a set of patterns -- what a watch would catch if
 *  it fired right now. Lets a subscription report "that matches nothing yet"
 *  instead of silently becoming a watch on a typo. */
export function addressesMatching(
  conversations: readonly ConversationLike[],
  patterns: readonly string[],
  now: number = Date.now(),
): string[] {
  const all = [...addressFleet(conversations, now).values()]
  return all.filter(address => matchesAnyPattern(patterns, address)).sort()
}
