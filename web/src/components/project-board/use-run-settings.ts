/**
 * The three run settings, as one value.
 *
 * They were three `useState`s in the dialog beside the submission state, and
 * every consumer then re-assembled `{cadence, target, concurrency}` by hand --
 * once for the request, once for the consequence sentence. Bundling them means
 * the dialog holds SUBMISSION only, and the object it sends is the same object
 * the copy describes, by construction rather than by matching field lists.
 *
 * Seeded from an existing run so RESUME opens on what that run was armed with
 * rather than on the defaults.
 */

import type { EpicCadence } from '@shared/epic-run-types'
import { parseWhen } from '@shared/epic-when'
import { useMemo, useState } from 'react'
import type { EpicRunState, StartEpicOptions } from '@/lib/epic-run-api'

export interface RunSettings {
  options: StartEpicOptions
  /**
   * Picking a gate REPLACES the axis rather than adding to it, because the
   * control is three exclusive buttons. Leaving it alone keeps whatever the run
   * was armed with -- including a multi-gate axis this dialog cannot express --
   * so a RESUME never silently un-queues a queued run.
   */
  setCadence: (v: EpicCadence) => void
  setTarget: (v: StartEpicOptions['target']) => void
  setConcurrency: (v: number) => void
  setPlan: (v: boolean) => void
  /** A RESUME cannot plan -- generation 0 already ran. The control is hidden
   *  rather than shown-and-ignored, because a ticked box that does nothing is
   *  worse than no box. */
  planApplies: boolean
}

export function useRunSettings(existing: EpicRunState | null): RunSettings {
  // PARSED, not indexed: a broker talking to an older sentinel can hand back
  // `cadence` as the bare string this field used to be, and `.join` on a string
  // is a crashed dialog rather than a wrong label.
  const [cadence, setGates] = useState<EpicCadence[]>(parseWhen(existing?.cadence))
  const [target, setTarget] = useState<StartEpicOptions['target']>(existing?.target ?? 'merged')
  const [concurrency, setConcurrency] = useState(existing?.concurrency ?? 3)
  const [plan, setPlan] = useState(true)
  // `planned` is set by the engine when generation 0 settles, so this is the
  // same question the store asks when it refuses to re-plan a resume.
  const planApplies = !existing?.planned
  const options = useMemo(
    () => ({ cadence, target, concurrency, plan: planApplies && plan }),
    [cadence, target, concurrency, plan, planApplies],
  )
  return { options, setCadence: gate => setGates([gate]), setTarget, setConcurrency, setPlan, planApplies }
}
