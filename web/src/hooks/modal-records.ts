/**
 * Record-level rules for the modal manager: how a record is born, how it moves,
 * and where restore navigates to.
 *
 * Pure (bar the one navigation call), so the store stays a list of intents and
 * these stay independently readable.
 */

import type { ManagedModalOpts, ModalPresentation, ModalRecord, ModalScope } from './modal-manager-types'
import { useConversationsStore } from './use-conversations'

/** Navigate the app to a modal's owner context. Global = stay put. */
export function warpToScope(scope: ModalScope): void {
  const conv = useConversationsStore.getState()
  if (scope.type === 'conversation') {
    if (conv.selectedConversationId !== scope.id) conv.selectConversation(scope.id, 'modal-restore')
  } else if (scope.type === 'project') {
    if (conv.selectedProjectUri !== scope.uri) conv.selectProject(scope.uri)
  }
}

/**
 * A record for `open`. Re-opening a LIVE surface keeps what the old one knew --
 * its size, when it opened, and what it is currently doing -- because re-opening
 * is not a new surface, it is the same one coming back to the front.
 */
export function newRecord(opts: ManagedModalOpts, scope: ModalScope, prev: ModalRecord | undefined): ModalRecord {
  return {
    id: opts.id,
    kind: opts.kind,
    title: opts.title,
    minimizable: opts.minimizable ?? true,
    scope,
    presentation: 'inline',
    maximized: prev?.maximized ?? false,
    openedAt: prev?.openedAt ?? Date.now(),
    ...(opts.notifyOnComplete && { notifyOnComplete: true }),
    ...(prev?.activity && { activity: prev.activity }),
  }
}

type Records = Record<string, ModalRecord>

/** Set one record's presentation. Returns the same map when there is nothing to set. */
export function withPresentation(records: Records, id: string, presentation: ModalPresentation): Records {
  const cur = records[id]
  if (!cur) return records
  return { ...records, [id]: { ...cur, presentation } }
}

/** Looking at it IS reading it -- the unread mark has done its job. */
export function withSeen(records: Records, id: string): Records {
  const cur = records[id]
  if (!cur?.activity?.unseen) return records
  return { ...records, [id]: { ...cur, activity: { ...cur.activity, unseen: false } } }
}
