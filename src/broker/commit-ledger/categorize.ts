/**
 * Commit categorization -- pure functions, no I/O. The broker derives every
 * classification itself rather than trusting the hook: a hook is a shell script
 * on someone else's machine, the broker is the one place the rules can be fixed
 * without reinstalling anything.
 */

import type { CommitIngestPayload, CommitKind, CommitOrigin } from '../../shared/commit-ledger'

/** `type(scope)!: subject` -- the conventional-commit header. Scope and the
 *  breaking `!` are both optional; a subject that doesn't match leaves every
 *  field null rather than guessing. */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]{1,64})\))?(!)?:\s+/i

export interface ConventionalParts {
  ccType: string | null
  ccScope: string | null
  ccBreaking: boolean
}

export function parseConventional(subject: string): ConventionalParts {
  const match = CONVENTIONAL.exec(subject)
  if (!match) return { ccType: null, ccScope: null, ccBreaking: false }
  return {
    ccType: match[1].toLowerCase(),
    ccScope: match[2] ? match[2].toLowerCase() : null,
    ccBreaking: Boolean(match[3]),
  }
}

/** Reflog action -> kind, for the actions that are unambiguous. `git reflog`
 *  is the ONLY precise amend signal a post-commit hook can see: an amended
 *  commit is otherwise indistinguishable from a sibling commit off the same
 *  parent, which under WORK MODE (many worktrees off main) is routine. */
const REFLOG_KINDS: Record<string, CommitKind> = {
  amend: 'amend',
  merge: 'merge',
  initial: 'initial',
  rebase: 'rebase',
  cherry: 'normal',
}

function kindFromReflog(reflogAction: string | undefined): CommitKind | null {
  if (!reflogAction) return null
  const lowered = reflogAction.toLowerCase()
  for (const [needle, kind] of Object.entries(REFLOG_KINDS)) {
    if (lowered.includes(needle)) return kind
  }
  return null
}

export function classifyKind(payload: CommitIngestPayload, subject: string): CommitKind {
  const fromReflog = kindFromReflog(payload.reflogAction)
  if (fromReflog) return fromReflog
  const parents = (payload.parents ?? '').trim()
  if (parents === '') return 'initial'
  if (parents.split(/\s+/).length > 1) return 'merge'
  if (/^revert[ :"]/i.test(subject)) return 'revert'
  return 'normal'
}

/** A commit made inside a conversation is the agent's; anything else came from
 *  a human at a terminal. That is the whole rule -- the env either carried a
 *  conversation id or it didn't, and there is no third case worth inventing. */
export function classifyOrigin(conversationId: string | null): CommitOrigin {
  return conversationId ? 'agent' : 'human'
}

/** Split a raw commit message into subject + body. Git's own convention:
 *  first line is the subject, everything after the first blank line is body. */
export function splitMessage(subject: string | undefined, body: string | undefined): [string, string] {
  const rawSubject = (subject ?? '').trim()
  const rawBody = (body ?? '').trim()
  if (rawSubject.includes('\n')) {
    const [first, ...rest] = rawSubject.split('\n')
    return [first.trim(), [rest.join('\n').trim(), rawBody].filter(Boolean).join('\n\n')]
  }
  return [rawSubject, rawBody]
}
