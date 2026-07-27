/**
 * Resolve a recap run's concrete model slugs.
 *
 * WHICH models belong together, and the measurement behind every choice, lives
 * in `shared/recap-suites.ts` -- this module only applies the override
 * precedence on top of a chosen suite:
 *
 *   1. an explicit per-stage slug (tuning.mapModel / .reduceModel / .oneshotModel)
 *   2. a per-stage env override (ops lever, no deploy)
 *   3. the suite
 *
 * The SUITE is authoritative for the synthesis models, replacing the old
 * audience-based split (human -> Opus, agent -> Sonnet). Audience decides what
 * the document SAYS; it should not also decide what model writes it, or two
 * mechanisms fight over one slug. A cheap agent brief is now spelled
 * `suite: 'cheap'`, which is the same request stated honestly.
 */

import type { RecapAudience } from '../../../../shared/protocol'
import { getSuite } from '../../../../shared/recap-suites'

function envModel(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k]
    if (v) return v
  }
  return undefined
}

/**
 * The MAP model is suite-independent by design -- see the note in
 * recap-suites.ts. Extraction is cached for 60 days, so a cheap map model's
 * thinner output poisons every recap that touches that conversation for two
 * months, and the cross-run cache already took the whole stage to ~$0.25/night.
 * There is nothing to win and a sticky regression to lose.
 */
export function mapModelForSuite(suiteId: string | undefined): string {
  return envModel('CLAUDWERK_RECAP_MAP_MODEL', 'RCLAUDE_RECAP_MAP_MODEL') ?? getSuite(suiteId).map
}

export function reduceModelForSuite(suiteId: string | undefined): string {
  return envModel('CLAUDWERK_RECAP_REDUCE_MODEL', 'RCLAUDE_RECAP_REDUCE_MODEL') ?? getSuite(suiteId).reduce
}

export function oneshotModelForSuite(suiteId: string | undefined): string {
  return envModel('CLAUDWERK_RECAP_ONESHOT_MODEL') ?? getSuite(suiteId).oneshot
}

export interface ChunkModels {
  mapModel: string
  reduceModel: string
}

/** Chunked-path slugs: explicit per-call override beats env beats suite. */
export function chunkModels(overrides?: Partial<ChunkModels>, suiteId?: string): ChunkModels {
  return {
    mapModel: overrides?.mapModel || mapModelForSuite(suiteId),
    reduceModel: overrides?.reduceModel || reduceModelForSuite(suiteId),
  }
}

/**
 * Guard for inputs so large that even a 1M-context model cannot hold them:
 * ~3.2M chars leaves headroom for the output plus tokenizer slack. Above it we
 * degrade to Sonnet as a best-effort valve. This is a CAPACITY ceiling, not a
 * quality choice -- the real answer for a period this size is the chunked
 * map-reduce path, which the threshold gate takes long before here.
 */
const CHUNK_CEILING_CHARS = 3_200_000
const OVERFLOW_MODEL = 'anthropic/claude-sonnet-5'

export interface ModelChoice {
  model: string
  reason: 'suite' | 'too-big'
}

/** Oneshot-path model. `audience` is retained in the signature because callers
 *  pass it and it may inform future capacity rules, but it no longer selects the
 *  model -- the suite does. */
export function pickModel(inputChars: number, _audience: RecapAudience = 'human', suiteId?: string): ModelChoice {
  if (inputChars > CHUNK_CEILING_CHARS) return { model: OVERFLOW_MODEL, reason: 'too-big' }
  return { model: oneshotModelForSuite(suiteId), reason: 'suite' }
}
