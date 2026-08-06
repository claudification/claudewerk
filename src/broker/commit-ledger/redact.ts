/**
 * Share-guest redaction for commit rows.
 *
 * A share-link guest must never see host disk paths -- the rule the header
 * ProjectPathRow / CurrentPathRow already follow client-side. A commit row
 * carries those paths verbatim in `repoUri` and `cwdUri`
 * (`claude://default/Users/jonas/projects/...`), so the SERVER strips them; the
 * control panel is not the gate (permission filtering is server-side only).
 *
 * Touched file paths stay -- they are repo-relative and are exactly what a
 * reviewer on a shared conversation is there to look at.
 */

import type { CommitRow } from '../../shared/commit-ledger'

/** What a share guest is allowed to see in place of a host path: the repo's
 *  own name, which the guest already knows from the conversation. */
function opaqueUri(repoName: string): string {
  return repoName ? `repo://${repoName}` : 'repo://hidden'
}

function redactCommitForShareGuest(row: CommitRow): CommitRow {
  const label = opaqueUri(row.repoName)
  return {
    ...row,
    repoUri: label,
    cwdUri: label,
    host: '',
    container: '',
    osUser: '',
    authorEmail: '',
  }
}

export function redactCommitsForShareGuest(rows: CommitRow[], isShareGuest: boolean): CommitRow[] {
  return isShareGuest ? rows.map(redactCommitForShareGuest) : rows
}
