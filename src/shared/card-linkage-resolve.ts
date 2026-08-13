/**
 * THE ONE RESOLVER. Every linkage verb's targets go through this pass and no
 * other: does the target exist, is the card pointing at itself, does following
 * the verb come back to where it started.
 *
 * Before this there was one hand-written copy of that logic per relation, which
 * is how `epic:` got a cycle check and `depends_on:` did not -- the same
 * contradiction, reported for one verb and invisible for the other. Adding a
 * verb to the registry (card-linkage.ts) now buys all three checks for free,
 * and there is exactly one place where the severity rule is enforced:
 *
 *   MISSING TARGET IS A WARNING. ALWAYS. NO VERB OVERRIDES IT.
 *
 * A card naming one that does not exist yet is out-of-order authoring, which is
 * normal and fine. Only a ring or a self-reference on an ordering verb is an
 * error, because those are things the board genuinely cannot resolve.
 */

import { type LinkageVerb, RESOLVABLE_VERBS } from './card-linkage'
import type { CardLinkage } from './card-linkage-read'
import type { DoctorFinding } from './project-doctor-types'

/** What the resolver needs of a card: an id, and its linkage keyed by STORAGE
 *  key (i.e. `readLinkage()` output, aliases already folded). */
export interface LinkedCard {
  id: string
  linkage: CardLinkage
}

/** A ring longer than this is a board somebody is fuzzing; stop walking rather
 *  than hang the doctor. */
const MAX_WALK = 64

function targetsOf(card: LinkedCard, verb: LinkageVerb): string[] {
  return card.linkage[verb.key] ?? []
}

/**
 * The path from `start` back to `start` following `verb`, or null if there is
 * none. Depth-first because a `many`-arity verb branches -- `epic:` happens to
 * be a functional graph where this degenerates to a straight walk.
 */
function findRing(start: string, verb: LinkageVerb, byId: ReadonlyMap<string, LinkedCard>): string[] | null {
  const stack: string[][] = [[start]]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const path = stack.pop() as string[]
    const head = path[path.length - 1]
    if (path.length > MAX_WALK) continue
    const node = byId.get(head)
    if (!node) continue
    for (const next of targetsOf(node, verb)) {
      if (next === start) return [...path, next]
      if (visited.has(next)) continue
      visited.add(next)
      stack.push([...path, next])
    }
  }
  return null
}

/** `claims epic "x"` reads right for a single-target verb; `depends_on "x"`
 *  reads right for a list. Same sentence either way, one word apart. */
function subjectPhrase(verb: LinkageVerb, target: string): string {
  return verb.arity === 'one' ? `claims ${verb.key} "${target}"` : `${verb.key} "${target}"`
}

function missingFinding(card: LinkedCard, verb: LinkageVerb, target: string): DoctorFinding {
  return {
    check: (verb.checks as { missing: string }).missing,
    severity: 'warning',
    subject: card.id,
    problem: `${subjectPhrase(verb, target)}, which this board does not have (yet)`,
    remedy: 'fine if that card is still to be written -- otherwise fix the id or drop it',
  }
}

function selfFinding(card: LinkedCard, verb: LinkageVerb): DoctorFinding {
  const fatal = verb.selfIsError === true
  return {
    check: (verb.checks as { self: string }).self,
    severity: fatal ? 'error' : 'info',
    subject: card.id,
    problem: fatal
      ? `${verb.key} lists itself, so it can never resolve`
      : `${verb.key} lists itself, which says nothing`,
    remedy:
      verb.arity === 'one'
        ? `remove the \`${verb.key}:\` key -- a card cannot be that to itself`
        : `remove "${card.id}" from ${verb.key}`,
  }
}

function cycleFinding(card: LinkedCard, verb: LinkageVerb, ring: string[]): DoctorFinding {
  return {
    check: (verb.checks as { cycle: string }).cycle,
    severity: 'error',
    subject: card.id,
    problem: `${verb.key} loops: ${ring.join(' -> ')}`,
    remedy: `break the ring -- remove \`${verb.key}\` from one card in it`,
  }
}

/** `relates_to` claims a two-way reading order, but it is stored one-sided, so
 *  half of every pair goes missing the moment somebody writes only one end. */
function oneSidedFinding(card: LinkedCard, verb: LinkageVerb, target: string): DoctorFinding {
  return {
    check: `${verb.key.replace(/_/g, '-')}-one-sided`,
    severity: 'info',
    subject: card.id,
    problem: `${verb.key} "${target}", but that card does not say so back`,
    remedy: `add \`${verb.key}: [${card.id}]\` to ${target} so the link reads from either end`,
  }
}

/** One edge: itself, nowhere, or a card that may owe it a link back. Exactly one
 *  finding per target at most -- a missing card is not ALSO one-sided. */
function targetFinding(
  card: LinkedCard,
  verb: LinkageVerb,
  target: string,
  byId: ReadonlyMap<string, LinkedCard>,
): DoctorFinding | null {
  if (target === card.id) return selfFinding(card, verb)
  const other = byId.get(target)
  if (!other) return missingFinding(card, verb, target)
  if (verb.symmetric && !targetsOf(other, verb).includes(card.id)) return oneSidedFinding(card, verb, target)
  return null
}

function resolveVerb(card: LinkedCard, verb: LinkageVerb, byId: ReadonlyMap<string, LinkedCard>): DoctorFinding[] {
  const targets = targetsOf(card, verb)
  const out = targets.map(t => targetFinding(card, verb, t, byId)).filter((f): f is DoctorFinding => f !== null)

  // One ring finding per CARD, not per edge: a card in two rings has one thing
  // wrong with it, and repeating the line per target is how a report becomes a
  // wall nobody reads. A card naming ITSELF is already the shortest possible
  // ring and was just reported as one -- walking it again only says it twice.
  if (verb.checks?.cycle && !targets.includes(card.id)) {
    const ring = findRing(card.id, verb, byId)
    if (ring) out.push(cycleFinding(card, verb, ring))
  }
  return out
}

/**
 * Every linkage problem on the board that is about TARGETS. Kind checks (is the
 * thing you called an epic actually one?) stay with the verb that owns the
 * notion -- this pass knows about ids and edges, nothing else.
 */
export function resolveLinkage(cards: readonly LinkedCard[]): DoctorFinding[] {
  const byId = new Map(cards.map(c => [c.id, c]))
  const findings: DoctorFinding[] = []
  for (const card of cards) {
    for (const verb of RESOLVABLE_VERBS) findings.push(...resolveVerb(card, verb, byId))
  }
  return findings
}

/** Cards this one points at with `verb`, as ids -- the read side every consumer
 *  of the registry shares instead of reaching into frontmatter itself. */
export function linkedIds(card: LinkedCard, key: string): string[] {
  return card.linkage[key] ?? []
}
