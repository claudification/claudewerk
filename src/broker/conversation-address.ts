/**
 * THE BROKER'S ADDRESS RESOLVER: turning a live conversation into its canonical
 * `project:conversation` address (the convention defined in
 * shared/conversation-address.ts).
 *
 * Split out of handlers/channel-id.ts so BOTH sides of the broker can address a
 * conversation the same way: the inter-conversation rail (handlers/) already did,
 * and now the desk / orb (desk/) needs to as well -- to match a status against a
 * watch pattern, and to show the orb an address it can actually name. desk/ does
 * not import from handlers/, so a shared function had to live above both rather
 * than be reached across the seam.
 *
 * CALLER-INDEPENDENT, which is the subtle part. `computeLocalId` is normally fed
 * a project slug from the CALLER'S address book, so the same conversation can be
 * `arr:worker` to one peer and `arr-2:worker` to another -- fine for routing a
 * reply, useless as a subscription key. `conversationAddress` always derives the
 * project half from the project's own label/dirname, so every subscriber names
 * the same conversation the same way.
 */

import { formatConversationAddress, slugifyAddressPart } from '../shared/conversation-address'
import { extractProjectLabel } from '../shared/project-uri'
import { isAliasLive } from './former-slugs'
import type { FormerSlug } from './store/types'

export interface ConversationLike {
  id: string
  project: string
  title?: string
  /** Retired addressable slugs with decay bookkeeping (rename-alias retention). */
  formerSlugs?: FormerSlug[]
}

/**
 * Compute the per-conversation slug suffix used inside compound ids.
 * Falls back to a 6-char id slice when two conversations in the same project would
 * slug to the same value (so siblings stay disambiguable).
 */
export function computeConversationSlug(
  target: ConversationLike,
  siblingConversations: ConversationLike[],
  now: number = Date.now(),
): string {
  const conversationSlug = slugifyAddressPart(target.title || target.id.slice(0, 8))
  // A name collides if a sibling CURRENTLY answers to it OR still holds it as an
  // in-window former slug (rename-alias retention) -- otherwise a fresh/renamed
  // conversation could grab a name that is still forwarding to someone else.
  const collides = siblingConversations.some(other => {
    if (other.id === target.id) return false
    if (slugifyAddressPart(other.title || other.id.slice(0, 8)) === conversationSlug) return true
    return (other.formerSlugs ?? []).some(f => f.slug === conversationSlug && isAliasLive(f, now))
  })
  return collides ? `${conversationSlug}-${target.id.slice(0, 6)}` : conversationSlug
}

/**
 * Always-compound local id: `project:conversation-slug`.
 *
 * Use for both `list_conversations` output and the from-id stamped on outgoing
 * messages so a recipient can replay it verbatim as `to`.
 */
export function computeLocalId(
  target: ConversationLike,
  projectSlug: string,
  siblingConversations: ConversationLike[],
): string {
  return formatConversationAddress(projectSlug, computeConversationSlug(target, siblingConversations))
}

/**
 * The project half everyone agrees on: the stored label, else the URI's last
 * path segment, slugged. This is the same rule `computeLocalId` falls back to
 * when there is no caller address book, which is what makes an address minted
 * here interchangeable with one minted on the inter-conversation rail.
 */
function canonicalProjectSlug(project: string, label?: string | null): string {
  return slugifyAddressPart(label || extractProjectLabel(project))
}

/**
 * The canonical, caller-independent address for one conversation.
 *
 * `siblings` should be the conversations at the SAME project (the collision
 * check only means anything within a project); passing the whole fleet is safe
 * but does more work.
 */
export function conversationAddress(
  target: ConversationLike,
  siblings: ConversationLike[],
  label?: string | null,
  now: number = Date.now(),
): string {
  return formatConversationAddress(
    canonicalProjectSlug(target.project, label),
    computeConversationSlug(target, siblings, now),
  )
}
