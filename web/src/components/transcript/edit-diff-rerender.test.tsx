/**
 * Regression test for the "Edit re-renders and re-applies diff coloring on
 * every transcript entry update" perf bug.
 *
 * The Edit diff is produced by renderEdit (tool-cases-core.tsx). When the tool
 * result carries no precomputed `structuredPatch`, renderEdit historically
 * called `structuredPatch()` (the `diff` lib) INSIDE the render body and handed
 * DiffView a brand-new `hunks` array every render -- which both recomputed the
 * O(file) diff AND busted DiffView's memo (re-tokenize via Shiki). So any
 * re-render of the (memoized) ToolLine re-ran the whole diff and re-coloured it.
 *
 * Two probes:
 *   - `structuredPatch` spy  -> how often the diff is recomputed.
 *   - DiffView render counter -> how often the coloured diff is re-rendered.
 *
 * Expected after the fix:
 *   - initial render -> 1 compute, 1 DiffView render.
 *   - re-render with identical props -> still 1 (ToolLine memo holds).
 *   - re-render that BUSTS ToolLine's memo (subagents ref churn -- a real live
 *     vector) -> still 1: the compute + the patches array must be memoized
 *     below the ToolLine memo boundary so a legit re-render is cheap.
 *
 * DiffView is mocked to a no-op counter: it strips the async Shiki highlight
 * effect (a test-env cleanup hazard) and gives a direct "diff re-coloured" count
 * while preserving DiffView's memo semantics (the fix relies on a stable
 * `patches` ref reaching it).
 */

import { cleanup, render } from '@testing-library/react'
import * as diff from 'diff'
import { memo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptContentBlock } from '@/lib/types'
import { MemoizedToolLine } from './tool-line'

// Count diff recomputes. Arrow form (not bare `vi.fn(actual.structuredPatch)`):
// the bare form invokes the impl with a mangled `this` and throws under render.
vi.mock('diff', async importOriginal => {
  const actual = await importOriginal<typeof import('diff')>()
  return {
    ...actual,
    structuredPatch: vi.fn((...args: Parameters<typeof actual.structuredPatch>) => actual.structuredPatch(...args)),
  }
})

// Replace DiffView with a memo'd render counter. Keeps memo semantics (default
// shallow compare on `patches`/`filePath`) so a stable patches ref skips it,
// but drops the real async Shiki highlighting that otherwise fires during
// testing-library cleanup.
const diffViewRender = vi.fn()
vi.mock('./tool-renderers', async importOriginal => {
  const actual = await importOriginal<typeof import('./tool-renderers')>()
  return {
    ...actual,
    DiffView: memo(function MockDiffView() {
      diffViewRender()
      return null
    }),
  }
})

const structuredPatchSpy = vi.mocked(diff.structuredPatch)

afterEach(cleanup)
beforeEach(() => {
  structuredPatchSpy.mockClear()
  diffViewRender.mockClear()
})

// A stable Edit tool block + result that forces renderEdit's compute path: no
// precomputed structuredPatch on the result, originalFile present -> the
// expensive full-file diff branch. ensureCanonical is idempotent (early-returns
// once kind+raw are set), so re-rendering this shared block is safe.
const ORIGINAL_FILE = ['const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5'].join('\n')
const editTool: TranscriptContentBlock = {
  type: 'tool_use',
  id: 'edit-1',
  name: 'Edit',
  input: { file_path: '/src/foo.ts', old_string: 'const a = 1', new_string: 'const a = 999' },
} as unknown as TranscriptContentBlock
const toolUseResult = { originalFile: ORIGINAL_FILE }

const noop = () => null

/** A ToolLine element for the Edit above. `subagents` is the only varying prop
 *  -- swapping its ref is exactly what the live subagents selector does on a
 *  subagent-state update, and it busts ToolLine's shallow memo. */
function line(subagents?: unknown[]) {
  return (
    <MemoizedToolLine
      tool={editTool}
      toolUseResult={toolUseResult}
      isError={false}
      expandAll={false}
      subagents={subagents as never}
      renderAgentInline={noop}
    />
  )
}

describe('Edit diff recompute on re-render', () => {
  it('computes + colours the diff once on initial render', () => {
    render(line())
    expect(structuredPatchSpy).toHaveBeenCalledTimes(1)
    expect(diffViewRender).toHaveBeenCalledTimes(1)
  })

  it('does NOT recompute when re-rendered with identical props (ToolLine memo holds)', () => {
    const { rerender } = render(line(undefined))
    rerender(line(undefined))
    rerender(line(undefined))
    expect(structuredPatchSpy).toHaveBeenCalledTimes(1)
    expect(diffViewRender).toHaveBeenCalledTimes(1)
  })

  it('does NOT recompute or re-colour when a memo-busting prop (subagents ref) changes', () => {
    const { rerender } = render(line(undefined))
    expect(structuredPatchSpy).toHaveBeenCalledTimes(1)
    expect(diffViewRender).toHaveBeenCalledTimes(1)
    // subagents undefined -> new [] ref busts the memo, forcing a real ToolLine
    // re-render. The diff must NOT recompute and DiffView must NOT re-render
    // (pre-fix both were 2).
    rerender(line([]))
    expect(structuredPatchSpy).toHaveBeenCalledTimes(1)
    expect(diffViewRender).toHaveBeenCalledTimes(1)
  })
})
