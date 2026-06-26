/**
 * SOTU per-distill run-artifact bundle (Phase 4) -- recap's Pillar C+ pattern, kept
 * thin. Every distill drops a `distills/<ts>/` dir with its inputs, the assembled
 * prompts, the raw model output, the produced chronicle, and the COST-2 ledger, so a
 * $X distill is fully auditable + replayable (the eval harness lands in Phase 7).
 *
 * VERSION-GATE (recap C++): the manifest stamps `pipelineVersion`; a future replay
 * refuses a bundle whose version no longer matches (don't stitch mismatched schemas).
 *
 * Best-effort + SECRET-FREE by construction: the prompts carry no apiKey (the bearer
 * only ever lives in the HTTP header). A write failure is swallowed -- the bundle is
 * an audit trail, never load-bearing for the distill itself.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecapCostLedger, SheafGrounding, SotuRecipe } from '../../../shared/protocol'
import { distillDir } from '../paths'
import type { Chronicle, Contribution, GitFabric, SotuDistillMode } from '../types'

/** One LLM leg of a distill (scribe and/or reconcile). */
export interface DistillLeg {
  system: string
  user: string
  raw: string
}

export interface DistillBundleInput {
  mode: SotuDistillMode
  project: string
  pipelineVersion: number
  startedAt: number
  completedAt: number
  /** New queued items this distill folded (the watermark drain). */
  queuedItems: Contribution[]
  /** Chronicle before the fold. */
  priorChronicle: Chronicle
  /** Latest git-fabric snapshot the reconcile re-grounded against (if any). */
  gitFabric?: GitFabric
  scribe?: DistillLeg
  reconcile?: DistillLeg
  /** Chronicle produced by this distill. */
  chronicle: Chronicle
  ledger: RecapCostLedger
  /** Self-describing recipe (Phase 7 -- recap args_json mirror): the resolved tuning
   *  actually used + budget/stakes context, so the distill is reproducible + QC-able. */
  recipe: SotuRecipe
  /** Citation-grounding of the produced chronicle vs the folded input (Pillar D).
   *  Absent when the distill failed before producing a chronicle. */
  grounding?: SheafGrounding
  error?: string
}

/** Persist a distill's bundle under `distills/<ts>/`. `ts` is the distill instant
 *  (its dir name). Best-effort: returns the dir on success, null on any IO error. */
export function writeDistillBundle(slug: string, ts: number, input: DistillBundleInput): string | null {
  try {
    const dir = distillDir(slug, ts)
    const write = (name: string, body: string): void => writeFileSync(join(dir, name), body)
    write(
      'manifest.json',
      `${JSON.stringify(
        {
          mode: input.mode,
          project: input.project,
          pipelineVersion: input.pipelineVersion,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          cost: input.ledger.summary,
          // Pillar D mirror: the recipe + grounding live IN the manifest (SOTU's
          // args_json) so the eval scan reads quality/cost/recipe from one file.
          recipe: input.recipe,
          folded: input.queuedItems.length,
          ...(input.grounding ? { grounding: input.grounding } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        },
        null,
        2,
      )}\n`,
    )
    // Standalone recipe.json -- the self-describing args_json, for a cheap variant
    // scan that never has to parse the full manifest.
    write('recipe.json', `${JSON.stringify(input.recipe, null, 2)}\n`)
    write(
      'inputs.json',
      `${JSON.stringify(
        { queuedItems: input.queuedItems, priorChronicle: input.priorChronicle, gitFabric: input.gitFabric },
        null,
        2,
      )}\n`,
    )
    if (input.scribe) writeLeg(write, 'scribe', input.scribe)
    if (input.reconcile) writeLeg(write, 'reconcile', input.reconcile)
    write('chronicle.json', `${JSON.stringify(input.chronicle, null, 2)}\n`)
    write('ledger.json', `${JSON.stringify(input.ledger, null, 2)}\n`)
    return dir
  } catch {
    return null
  }
}

function writeLeg(write: (name: string, body: string) => void, name: string, leg: DistillLeg): void {
  write(`${name}-prompt.txt`, `=== SYSTEM ===\n${leg.system}\n\n=== USER ===\n${leg.user}\n`)
  write(`${name}-raw.txt`, leg.raw)
}
