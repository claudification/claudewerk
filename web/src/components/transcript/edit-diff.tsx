import { structuredPatch } from 'diff'
import { memo, useMemo } from 'react'
import { DiffView } from './tool-renderers'

/** Computes the Edit patch and renders the coloured diff. The structuredPatch
 *  call is in a useMemo keyed on the (string) inputs, NOT in renderEdit's render
 *  body -- so a ToolLine re-render (e.g. subagents-ref churn during streaming)
 *  reuses the cached hunks instead of re-diffing the whole file, and DiffView
 *  receives a stable `patches` ref so its own memo holds (no Shiki re-tokenize).
 *  Lives in its own component-only module for Fast Refresh hygiene
 *  (only-export-components). See edit-diff-rerender.test.tsx. */
export const EditDiff = memo(function EditDiff({
  oldText,
  newText,
  originalFile,
  filePath,
}: {
  oldText: string
  newText: string
  originalFile?: string
  filePath?: string
}) {
  const patches = useMemo(() => {
    const patch = originalFile
      ? structuredPatch('file', 'file', originalFile, originalFile.replace(oldText, newText), '', '', { context: 3 })
      : structuredPatch('file', 'file', oldText, newText, '', '', { context: 3 })
    return patch.hunks
  }, [oldText, newText, originalFile])
  if (patches.length === 0) return null
  return <DiffView patches={patches} filePath={filePath} />
})
