/**
 * THE HARVEST -- the guard's `set_status` caveats and notes, folded onto the card
 * it just settled.
 *
 * A verifier writes its verdict with `project_set_status`, then finishes the turn
 * with `set_status(state:'done', caveats, notes)` because THAT is the handoff the
 * control panel renders. The two say different things and only one of them used
 * to survive: the caveats sat in the conversation's status row, the card carried
 * nothing, and once the conversation aged out the caveat was gone.
 *
 * ORDER IS WHY THIS EXISTS AT ALL. The verdict comes FIRST (it is the move) and
 * the status LAST (it is the sign-off), so `project_set_status` cannot read a
 * status that has not been reported yet. Inverting the flow -- remember the card
 * at verdict time, enrich it when the status arrives -- is what makes the harvest
 * automatic rather than a thing the prompt has to ask an agent to repeat.
 *
 * IN-PROCESS AND PER-CONVERSATION. An MCP host serves one conversation, so this
 * map holds at most one entry in practice; it is keyed anyway so a host that ever
 * serves two cannot cross their verdicts. Nothing here survives a restart, and it
 * does not need to: the verdict itself is already on disk before this runs.
 */

import type { VerdictInput } from '../../../shared/card-verdict'
import { writeVerdictToCard } from './card-verdict-write'

interface VerdictMemo {
  cardId: string
  cardPath: string
  input: VerdictInput
}

const memos = new Map<string, VerdictMemo>()

/** Record a verdict this conversation has just written, so a later status can
 *  enrich it. Called ONLY after the write actually landed. */
export function rememberVerdict(conversationId: string, memo: VerdictMemo): void {
  if (conversationId) memos.set(conversationId, memo)
}

/** Drop a conversation's memo. Tests, and any caller that wants a clean slate. */
export function forgetVerdict(conversationId: string): void {
  memos.delete(conversationId)
}

export interface StatusExtras {
  caveats?: string
  notes?: string
}

/**
 * Fold a status report's caveats/notes into the verdict this conversation last
 * wrote. Returns a line for the `set_status` result, or '' when there is nothing
 * to say -- no verdict written, or a status carrying neither field.
 *
 * A FAILED re-write is REPORTED, not swallowed. It is not the verdict failing --
 * that already landed and `project_set_status` would have refused otherwise --
 * but an agent told nothing would believe the caveat is on the card.
 */
export function harvestVerdictExtras(conversationId: string | undefined, extras: StatusExtras): string {
  if (!conversationId) return ''
  const memo = memos.get(conversationId)
  if (!memo) return ''
  const caveats = extras.caveats?.trim()
  const notes = extras.notes?.trim()
  if (!caveats && !notes) return ''

  const input: VerdictInput = {
    ...memo.input,
    ...(caveats ? { caveats } : {}),
    ...(notes ? { notes } : {}),
  }
  const res = writeVerdictToCard(memo.cardPath, input)
  if (!res.ok) {
    return (
      ` WARNING: your caveats/notes could NOT be added to the verdict on \`${memo.cardId}\` (${res.error}). ` +
      'The verdict itself is on the card; this detail is not. Put it there yourself.'
    )
  }
  memos.set(conversationId, { ...memo, input })
  const fields = [caveats && 'caveats', notes && 'notes'].filter(Boolean).join(' + ')
  return ` Your ${fields} were added to the verdict on \`${memo.cardId}\`.`
}
