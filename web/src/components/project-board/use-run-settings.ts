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

import { useMemo, useState } from 'react'
import type { EpicRunState, StartEpicOptions } from '@/lib/epic-run-api'

export interface RunSettings {
  options: StartEpicOptions
  setCadence: (v: StartEpicOptions['cadence']) => void
  setTarget: (v: StartEpicOptions['target']) => void
  setConcurrency: (v: number) => void
}

export function useRunSettings(existing: EpicRunState | null): RunSettings {
  const [cadence, setCadence] = useState<StartEpicOptions['cadence']>(existing?.cadence ?? 'now')
  const [target, setTarget] = useState<StartEpicOptions['target']>(existing?.target ?? 'merged')
  const [concurrency, setConcurrency] = useState(existing?.concurrency ?? 3)
  const options = useMemo(() => ({ cadence, target, concurrency }), [cadence, target, concurrency])
  return { options, setCadence, setTarget, setConcurrency }
}
