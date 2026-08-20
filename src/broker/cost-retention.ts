/**
 * How far back the `turns` table goes -- stated ONCE.
 *
 * It used to be a local const inside the boot function that arms the prune
 * timer, which was fine while the prune was the only thing that cared. It is no
 * longer: the activity matrix has to tell a viewer WHY eleven months of the
 * turns/tokens/USD grid are grey, and the honest answer is "this exact number".
 * Two copies of a retention window is the failure `card-ledger-store.ts` calls
 * out in its own header -- a question the next person has to ask twice, with two
 * places to get a different answer.
 *
 * Lives beside the broker rather than in `shared/` because it is a fact about
 * this server's sweep, not part of any wire contract. The horizon that reaches
 * the client is DERIVED from it and travels in the payload.
 */

/** Turns (and their hourly rollup) are deleted past 30 days. Both halves go in
 *  the same `costs.pruneOlderThan()` call, at the same cutoff -- the rollup does
 *  NOT outlive the raw rows it summarises. */
export const COST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
