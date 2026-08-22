/**
 * WHAT THE RUNNING BUILD CAN ALREADY DO -- the other half of `requires_deploy:`.
 *
 * A card that migrates DATA to match a rename is only valid once the code half
 * of that rename is the code actually serving the board. Nothing expressed that.
 * `werk-rename-seats` moved `needs-overseer` -> `needs-werk-master` in source and
 * deliberately kept no alias; the eleven cards still carrying the old word were
 * left for a follow-up chore, and running that chore against the OLDER broker
 * image that was still serving the project would have silently un-asked eleven
 * questions -- every one of them would stop matching the predicate the RUNNING
 * engine folds over, on a live board, with no error anywhere.
 *
 * `depends_on:` cannot say this. It sequences one CARD behind another, and both
 * cards can be `done` while the thing that reads them is a month-old process.
 *
 * SO THE TOKEN IS COMPILED IN, and that is the entire trick. This array ships
 * INSIDE the build. A process can therefore answer "do I speak this word?" about
 * ITSELF, truthfully, with no deploy manifest to consult, no version string to
 * parse and nothing to keep in sync -- the same reason card-schema-keys.ts is
 * TypeScript rather than a yaml file beside the board.
 *
 * FAIL CLOSED. `missingCapabilities` reports an unrecognised token as MISSING,
 * never as satisfied. That is what makes the mechanism work forwards: a card
 * naming a token added in a build newer than the one reading it is withheld by a
 * build that has never heard of it, which is exactly the state the card is
 * guarding against. The opposite default -- unknown means fine -- would make the
 * key decorative on precisely the deploys it exists for.
 *
 * THE ONE GAP, said out loud because a mechanism whose limits are not written
 * down gets trusted past them: a build predating this file has neither the
 * tokens nor the withhold rule, so it dispatches such a card regardless. Nothing
 * can fix that from inside -- an old process cannot be taught a new refusal.
 * This protects the NEXT code+data rename, not the one that motivated it.
 *
 * IT ALSO ONLY SPEAKS FOR THE PROCESS THAT READS IT. The broker and the sentinel
 * are separate bundles on separate deploy cadences; a token satisfied inside the
 * broker says nothing about the sentinel. `PlanCohortInput.capabilities` exists
 * so a caller that knows better can hand in the INTERSECTION rather than its own
 * set. No caller does that yet -- there is no cross-process build handshake to
 * compute it from -- so the default is the honest single-process answer.
 *
 * APPEND-ONLY. A token is never removed and never renamed: some card, somewhere,
 * on some board this repo does not own, may still name it, and dropping the token
 * turns that card from dispatchable into permanently withheld. The cost of an
 * entry nobody references any more is one line.
 */

/**
 * Every capability token THIS build provides, newest last.
 *
 * ADD A TOKEN IN THE SAME COMMIT AS THE CODE IT NAMES. A token that lands ahead
 * of its code is a lie the fold has no way to catch, and one that lands after is
 * a card withheld from a build that would have been fine.
 */
export const DEPLOYED_CAPABILITIES: readonly string[] = [
  /**
   * The blocked channel is keyed on `needs-werk-master`, not on `needs-overseer`
   * (`werk-rename-seats`, merged 106d99fe). A board migration that rewrites the
   * stored tag requires this: a build without it folds over the old word, so the
   * migrated cards stop being questions the moment they are migrated.
   */
  'needs-werk-master-tag',
] as const

const PROVIDED: ReadonlySet<string> = new Set(DEPLOYED_CAPABILITIES)

/**
 * Which of `required` the deployment does NOT provide, in the order the card
 * named them. Empty means the card is clear to run here.
 *
 * The ORDER is the card's, not the registry's, because this list is printed back
 * to a human in `idleReason` and "the first token on the card is the first token
 * in the message" is the only mapping that reads without a second lookup.
 *
 * `provided` defaults to this build's own set. A caller passes one only when it
 * genuinely knows more -- see `PlanCohortInput.capabilities`.
 */
export function missingCapabilities(
  required: readonly string[] | undefined,
  provided: ReadonlySet<string> = PROVIDED,
): string[] {
  if (!required || required.length === 0) return []
  return required.filter(token => !provided.has(token))
}
