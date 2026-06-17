/**
 * THE DIALOGUE (D3) — turns-per-dialog telemetry.
 *
 * In the batched model every earned agent round-trip on a live dialog is a
 * `submit` event reaching the host. Counting submits per dialog surfaces
 * OVERUSE: a persistent dialog that burns many agent turns is exactly the
 * anti-pattern the skill decision-rule warns against (use one-shot / `pages` /
 * client-side interactions unless you genuinely re-derive content each round).
 *
 * Lightweight on purpose: an in-memory rollup + one structured log line per
 * turn, with an OVERUSE marker once a dialog crosses the soft threshold. No
 * persistence, no protocol surface, no new wire message — pure observability so
 * a future engineer can grep `[dialog-telemetry]` and see which dialogs are
 * turn-hungry. (LOG EVERYTHING covenant: every line carries ids + counts + age.)
 */

/** Soft threshold: a live dialog consuming this many earned turns is flagged. */
export const DIALOG_TURN_WARN_THRESHOLD = 8

interface DialogTurnStat {
  turns: number
  firstAtMs: number
  lastAtMs: number
}

/** Minimal logger surface (broker `ctx.log` has no `warn`; overuse is marked inline). */
export interface DialogTurnLogger {
  info(msg: string): void
}

const stats = new Map<string, DialogTurnStat>()

/** Test-only: clear the rollup between cases. */
export function resetDialogTurnStats(): void {
  stats.clear()
}

/** Current earned-turn count for a dialog (for diag / rollup readers). */
export function dialogTurnCount(dialogId: string): number {
  return stats.get(dialogId)?.turns ?? 0
}

/**
 * Record one earned agent turn (a `submit` event reaching the host) for a
 * dialog and emit a structured log line. Returns the new turn count. Marks
 * `OVERUSE` once the count crosses {@link DIALOG_TURN_WARN_THRESHOLD}.
 */
export function recordDialogTurn(
  conversationId: string,
  dialogId: string,
  nowMs: number,
  log: DialogTurnLogger,
): number {
  const prev = stats.get(dialogId)
  const stat: DialogTurnStat = prev
    ? { turns: prev.turns + 1, firstAtMs: prev.firstAtMs, lastAtMs: nowMs }
    : { turns: 1, firstAtMs: nowMs, lastAtMs: nowMs }
  stats.set(dialogId, stat)

  const spanMs = stat.lastAtMs - stat.firstAtMs
  const base = `[dialog-telemetry] turn dialog=${dialogId.slice(0, 8)} conv=${conversationId.slice(0, 8)} turns=${stat.turns} spanMs=${spanMs}`
  log.info(
    stat.turns >= DIALOG_TURN_WARN_THRESHOLD
      ? `${base} OVERUSE (>=${DIALOG_TURN_WARN_THRESHOLD} earned turns; prefer one-shot/pages/client-side)`
      : base,
  )
  return stat.turns
}
