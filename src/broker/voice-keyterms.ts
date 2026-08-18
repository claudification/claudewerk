/**
 * voice-keyterms - resolve a project's domain vocabulary for the voice pipeline.
 *
 * Two callers now need this and they must not drift: the relay path feeds it to
 * Deepgram as keyterm biasing AND to the refiner, and the direct path's refine
 * route feeds it to the refiner alone. Extracted from voice-stream.ts when the
 * second caller appeared.
 *
 * Keyterms are the single highest-value input the refiner gets -- they are the
 * ground truth that turns "psalm tinnell" back into `sentinel`. An empty list is
 * a normal answer (a project with no configured vocabulary), not a failure.
 *
 * The store arrives as a parameter rather than an import, matching voice-stream's
 * existing shape and keeping this unit testable without a live broker.
 */

import { getProjectSettings } from './project-settings'

interface ConversationLookup {
  getConversation(id: string): { project?: string | null } | null | undefined
}

export function resolveKeyterms(
  store: ConversationLookup,
  project?: string | null,
  conversationId?: string | null,
): string[] {
  const uri = project || (conversationId ? store.getConversation(conversationId)?.project : null)
  if (!uri) return []
  return getProjectSettings(uri)?.keyterms?.slice() ?? []
}
