/**
 * KEYS THAT LOOK LIKE LINKAGE AND ARE NOT.
 *
 * Frontmatter is an open bag, which is right for `evidence_*` and wrong for
 * relationships: write `blocked-by:` instead of `blocked_by:`, or `epics:`
 * instead of `epic:`, and the card is accepted, the key is preserved forever,
 * and absolutely nothing reads it. There is no error, no render difference, no
 * way to notice. That is the failure mode this file exists for -- the verb is
 * gone and the card looks fine.
 *
 * Deliberately conservative. Only two things get reported as a possible verb: a
 * NEAR-MISS on a key the registry knows (that is a typo, and a typo is the
 * whole point), and a key whose first word is relational vocabulary. A key that
 * is merely unfamiliar is left alone -- PRESERVE-UNKNOWN-KEYS is a promise, and
 * a check that nags about `evidence_diffstat` gets switched off in a day, which
 * costs the typo check too.
 */

import { LINKAGE_VERBS, type LinkageVerb, linkageVerb } from './card-linkage'
import type { DoctorFinding } from './project-doctor-types'
import { firstWord, nearestVerb, RELATIONAL_WORDS, STORE_KEYS } from './project-doctor-linkage-match'

export interface LinkageKeySource {
  id: string
  /** Raw frontmatter, exactly as parsed -- shapes matter here, so this must not
   *  be a projected card. */
  meta: Record<string, unknown>
}

/** A verb spelled a way nothing reads. The single highest-value finding here. */
function typoFinding(id: string, key: string, meant: string): DoctorFinding {
  return {
    check: 'linkage-verb-typo',
    severity: 'warning',
    subject: id,
    problem: `\`${key}:\` is not a linkage verb -- nothing reads it. Did you mean \`${meant}:\`?`,
    remedy: `rename the key to \`${meant}:\``,
  }
}

function unknownFinding(id: string, key: string): DoctorFinding {
  return {
    check: 'linkage-verb-unknown',
    severity: 'info',
    subject: id,
    problem: `\`${key}:\` reads like a relationship, but it is not a linkage verb and nothing follows it`,
    remedy: `use one of ${LINKAGE_VERBS.filter(v => !v.deprecated)
      .map(v => v.key)
      .join(', ')}, or move it into the body`,
  }
}

function aliasFinding(id: string, key: string, storedAs: string): DoctorFinding {
  return {
    check: 'linkage-alias',
    severity: 'info',
    subject: id,
    problem: `\`${key}:\` is an accepted spelling of \`${storedAs}:\` -- it works, but the board stores one form`,
    remedy: `rename it to \`${storedAs}:\`; any write through the store does this for you`,
  }
}

function deprecatedFinding(id: string, key: string, why: string): DoctorFinding {
  return {
    check: 'linkage-deprecated',
    severity: 'info',
    subject: id,
    problem: `\`${key}:\` is deprecated`,
    remedy: why,
  }
}

/** Shape problems. A list where one value belongs LOSES the rest, so it is a
 *  warning; a bare string where a list belongs is read as a one-item list and
 *  is only non-canonical, so it is not. */
function arityFinding(id: string, key: string, arity: 'one' | 'many'): DoctorFinding {
  if (arity === 'one') {
    return {
      check: 'linkage-arity',
      severity: 'warning',
      subject: id,
      problem: `\`${key}:\` holds a list, but it takes exactly one value -- only the first is used`,
      remedy: `keep one value: \`${key}: <card-id>\``,
    }
  }
  return {
    check: 'linkage-arity',
    severity: 'info',
    subject: id,
    problem: `\`${key}:\` holds a bare value where the board writes a list`,
    remedy: `write it as a list: \`${key}: [<card-id>]\``,
  }
}

/** An empty value asserts nothing, whatever the key -- and nagging about
 *  `blocks: []`, which 16 cards carry as leftover scaffolding, is how a report
 *  gets ignored wholesale. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

/** A key the registry does not know: a typo, an invented relation, or -- most
 *  often, and correctly -- none of our business. */
function unregisteredFindings(id: string, key: string): DoctorFinding[] {
  if (STORE_KEYS.has(key)) return []
  const meant = nearestVerb(key)
  if (meant) return [typoFinding(id, key, meant)]
  if (RELATIONAL_WORDS.has(firstWord(key))) return [unknownFinding(id, key)]
  return []
}

/** A key the registry DOES know: is it the canonical spelling, is it still the
 *  current verb, and is its value the right shape? */
function registeredFindings(id: string, key: string, value: unknown, verb: LinkageVerb): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  if (verb.storedAs) findings.push(aliasFinding(id, key, verb.storedAs))
  if (verb.deprecated) findings.push(deprecatedFinding(id, key, verb.deprecated))
  const mismatched = verb.arity === 'one' ? Array.isArray(value) : !Array.isArray(value)
  if (mismatched) findings.push(arityFinding(id, key, verb.arity))
  return findings
}

/** Every key-level linkage problem on one card. Target resolution is somebody
 *  else's job (card-linkage-resolve.ts) -- this pass only reads spellings. */
export function checkLinkageKeys(source: LinkageKeySource): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  for (const [key, value] of Object.entries(source.meta)) {
    if (isEmpty(value)) continue
    const verb = linkageVerb(key)
    findings.push(...(verb ? registeredFindings(source.id, key, value, verb) : unregisteredFindings(source.id, key)))
  }
  return findings
}
