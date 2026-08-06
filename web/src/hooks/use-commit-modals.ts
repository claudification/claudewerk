/**
 * Openers for the two commit surfaces. Both are MANAGED (parkable, dockable,
 * detachable) per the detachable-surfaces covenant -- a browser you can park
 * while you go read the conversation it pointed you at is the entire workflow.
 */

import { create } from 'zustand'
import { useModalManagerStore } from './use-modal-manager'

const BROWSER_MODAL = { id: 'commit-browser', kind: 'commit-browser', title: 'Commits' }
const DETAIL_MODAL = { id: 'commit-detail', kind: 'commit-detail', title: 'Commit' }

interface CommitModalState {
  /** Hash the detail surface is showing. */
  hash: string | null
  setHash: (hash: string | null) => void
  /** Project filter the browser opened with (empty = the whole fleet). */
  projectFilter: string | null
  setProjectFilter: (uri: string | null) => void
}

export const useCommitModalStore = create<CommitModalState>(set => ({
  hash: null,
  setHash: hash => set({ hash }),
  projectFilter: null,
  setProjectFilter: projectFilter => set({ projectFilter }),
}))

/** Open the global chronological browser. Pass a project URI to pre-filter. */
export function openCommitBrowser(projectUri?: string): void {
  useCommitModalStore.getState().setProjectFilter(projectUri ?? null)
  useModalManagerStore.getState().open(BROWSER_MODAL, { type: 'global' })
}

/** Open one commit's full detail. */
export function openCommitDetail(hash: string): void {
  useCommitModalStore.getState().setHash(hash)
  useModalManagerStore.getState().open(DETAIL_MODAL, { type: 'global' })
}
