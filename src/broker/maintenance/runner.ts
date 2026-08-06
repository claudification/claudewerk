import type { StepResult } from './types'

/** Accumulates step results and short-circuits the run on the first failure of
 *  a step later steps depend on.
 *
 *  Every path through a maintenance run records a line -- ok, skipped or
 *  failed, always with a reason. A report missing a step cannot be told apart
 *  from a step that silently vanished, which is exactly the ambiguity you do
 *  not want at 05:00 with rows already deleted. */
export class Runner {
  readonly steps: StepResult[] = []
  aborted = false
  abortReason = ''

  async step(name: string, fn: () => Promise<string> | string): Promise<boolean> {
    if (this.aborted) {
      this.steps.push({ step: name, status: 'skipped', detail: 'run already aborted', durationMs: 0 })
      return false
    }
    const t0 = Date.now()
    try {
      const detail = await fn()
      this.steps.push({ step: name, status: 'ok', detail, durationMs: Date.now() - t0 })
      return true
    } catch (err) {
      const detail = (err as Error).message
      this.steps.push({ step: name, status: 'failed', detail, durationMs: Date.now() - t0 })
      this.abort(`${name}: ${detail}`)
      return false
    }
  }

  skip(name: string, detail: string): void {
    this.steps.push({ step: name, status: 'skipped', detail, durationMs: 0 })
  }

  record(name: string, status: StepResult['status'], detail: string): void {
    this.steps.push({ step: name, status, detail, durationMs: 0 })
  }

  abort(reason: string): void {
    this.aborted = true
    this.abortReason = reason
  }
}
