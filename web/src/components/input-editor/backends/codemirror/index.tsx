/**
 * <CodeMirrorBackend> -- CM6 implementation of the InputEditor backend.
 *
 * The actual CM rendering is in CodeMirrorBackendInner (see ./inner.tsx),
 * which is React.lazy'd so legacy users pay zero bundle cost.
 *
 * Vite splits anything reachable only through the lazy import into its own
 * chunk -- @uiw/react-codemirror, all @codemirror/* modules, our extensions,
 * autocomplete, paste-drop helpers all land together.
 */

import { lazy, Suspense } from 'react'
import type { InputEditorProps } from '../../types'

const CodeMirrorBackendInner = lazy(() => import('./inner'))

export function CodeMirrorBackend(props: InputEditorProps) {
  return (
    <Suspense fallback={<div className={`min-h-[1.5em] ${props.className ?? ''}`} />}>
      <CodeMirrorBackendInner {...props} />
    </Suspense>
  )
}
