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
import { patchesEqual } from './tool-renderers-utils'

// Count diff recomputes. Arrow form (not bare `vi.fn(actual.structuredPatch)`):
// the bare form invokes the impl with a mangled `this` and throws under render.
vi.mock('diff', async importOriginal => {
  const actual = await importOriginal<typeof import('diff')>()
  return {
    ...actual,
    structuredPatch: vi.fn((...args: Parameters<typeof actual.structuredPatch>) => actual.structuredPatch(...args)),
  }
})

// Replace DiffView with a memo'd render counter. Reuses the real
// `patchesEqual` so Path A (precomputed structuredPatch on toolUseResult)
// is exercised with the SAME memo semantics the real DiffView has -- a fresh
// array ref with structurally-equal hunks must NOT bust the memo. Drops the
// real async Shiki highlight (a test-env cleanup hazard).
const diffViewRender = vi.fn()
vi.mock('./tool-renderers', async importOriginal => {
  const actual = await importOriginal<typeof import('./tool-renderers')>()
  return {
    ...actual,
    DiffView: memo(
      function MockDiffView(_props: { patches: Array<{ oldStart: number; lines: string[] }>; filePath?: string }) {
        diffViewRender()
        return null
      },
      (a, b) => a.filePath === b.filePath && patchesEqual(a.patches, b.patches),
    ),
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

/** A ToolLine element for the Edit above. To force a memo-busting re-render we
 *  swap `renderAgentInline` to a fresh function ref -- ToolLine's shallow memo
 *  breaks on the new identity, exactly as a parent re-render passing an unstable
 *  callback would. (The former subagents-array prop was the original vector;
 *  it was removed when subagent state stopped being prop-drilled -- a churning
 *  subagent poll can no longer bust this memo at all. See
 *  subagents-decouple.test.tsx.) */
function line(renderAgentInline: (agentId: string, toolId?: string) => null = noop) {
  return (
    <MemoizedToolLine
      tool={editTool}
      toolUseResult={toolUseResult}
      isError={false}
      expandAll={false}
      renderAgentInline={renderAgentInline}
    />
  )
}

describe('patchesEqual', () => {
  it('treats fresh array refs with identical content as equal (DiffView memo invariant)', () => {
    const a = [{ oldStart: 1, lines: ['+ const a = 1'] }]
    const b = [{ oldStart: 1, lines: ['+ const a = 1'] }]
    expect(patchesEqual(a, b)).toBe(true)
    expect(patchesEqual(a, [{ oldStart: 1, lines: ['+ const a = 2'] }])).toBe(false)
  })
})

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

  it('does NOT recompute or re-colour when a memo-busting prop (unstable callback ref) changes', () => {
    const { rerender } = render(line())
    expect(structuredPatchSpy).toHaveBeenCalledTimes(1)
    expect(diffViewRender).toHaveBeenCalledTimes(1)
    // A fresh renderAgentInline ref busts ToolLine's shallow memo, forcing a
    // real ToolLine re-render. The diff must NOT recompute and DiffView must
    // NOT re-render (pre-fix both were 2).
    rerender(line(() => null))
    expect(structuredPatchSpy).toHaveBeenCalledTimes(1)
    expect(diffViewRender).toHaveBeenCalledTimes(1)
  })
})

/** Path A regression: CC's real Edit tool results carry a precomputed
 *  `structuredPatch` on toolUseResult, so renderEdit skips EditDiff and hands
 *  the array straight to DiffView. The transcript pipeline rehydrates
 *  toolUseResult on every tick -- new array ref, identical contents. Before
 *  this fix, DiffView's default shallow memo broke on the ref change and
 *  re-ran Shiki on every update ("diffs re-rendering FULLY on each transcript
 *  update"). After the fix, DiffView uses structural equality on patches. */
describe('Edit diff: precomputed structuredPatch path (Path A)', () => {
  function lineWithPatch(patch: Array<{ oldStart: number; lines: string[] }>) {
    return (
      <MemoizedToolLine
        tool={editTool}
        toolUseResult={{ structuredPatch: patch }}
        isError={false}
        expandAll={false}
        renderAgentInline={noop}
      />
    )
  }

  it('does NOT re-colour when toolUseResult is rehydrated with structurally-equal patches', () => {
    // First render with one patch ref.
    const patch1 = [{ oldStart: 1, lines: [' const a = 1', '-const b = 2', '+const b = 999'] }]
    const { rerender } = render(lineWithPatch(patch1))
    expect(diffViewRender).toHaveBeenCalledTimes(1)
    // Rehydrate: fresh array, fresh inner objects, fresh inner arrays --
    // every reference is new -- but contents are identical. Shallow memo
    // would break; structural memo must hold.
    const patch2 = [{ oldStart: 1, lines: [' const a = 1', '-const b = 2', '+const b = 999'] }]
    rerender(lineWithPatch(patch2))
    expect(diffViewRender).toHaveBeenCalledTimes(1)
  })

  it('DOES re-render when patch contents actually change', () => {
    const patch1 = [{ oldStart: 1, lines: [' const a = 1', '-const b = 2', '+const b = 999'] }]
    const { rerender } = render(lineWithPatch(patch1))
    expect(diffViewRender).toHaveBeenCalledTimes(1)
    const patch2 = [{ oldStart: 1, lines: [' const a = 1', '-const b = 2', '+const b = 7777'] }]
    rerender(lineWithPatch(patch2))
    expect(diffViewRender).toHaveBeenCalledTimes(2)
  })
})
