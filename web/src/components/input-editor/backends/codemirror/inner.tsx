/**
 * The actual CM rendering surface. Imports CodeMirror + extensions eagerly;
 * loaded lazily from index.tsx so the chunk only ships when used.
 */

import type { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { useMemo, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { isMobileViewport } from '@/lib/utils'
import type { InputEditorProps } from '../../types'
import { buildInputExtensions } from './extensions'
import { attachPasteUpload, uploadDroppedFile } from './paste-drop'

export default function CodeMirrorBackendInner(props: InputEditorProps) {
  const [dragOver, setDragOver] = useState(false)
  const sessionId = useSessionsStore(s => s.selectedSessionId)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const viewRef = useRef<EditorView | null>(null)

  // Latest-callback ref so the keymap can call into a fresh handler
  // without rebuilding extensions on every render.
  const onSubmitRef = useRef(props.onSubmit)
  onSubmitRef.current = props.onSubmit

  // Build extensions once. Boolean toggles (enableAutocomplete, etc.) are
  // captured at mount time; matches legacy behavior.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot
  const extensions = useMemo(
    () =>
      buildInputExtensions({
        onSubmit: () => onSubmitRef.current(),
        fontSize: isMobileViewport() ? 15 : 14,
        enableEffortKeywords: props.enableEffortKeywords,
        enableAutocomplete: props.enableAutocomplete,
      }),
    [],
  )

  function onCreateEditor(view: EditorView) {
    viewRef.current = view
    attachPasteUpload(view, () => sessionIdRef.current)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    const view = viewRef.current
    if (!view) return
    for (const file of files) uploadDroppedFile(view, file, sessionIdRef.current)
  }

  return (
    <div
      className={`relative w-full ${props.className ?? ''}`}
      onDragOver={e => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <CodeMirror
        value={props.value}
        onChange={props.onChange}
        extensions={extensions}
        placeholder={props.placeholder}
        editable={!props.disabled}
        readOnly={props.disabled}
        autoFocus={props.autoFocus}
        basicSetup={false}
        theme="dark"
        onCreateEditor={onCreateEditor}
      />
      {dragOver && (
        <div className="absolute inset-0 border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none flex items-center justify-center">
          <span className="text-xs font-mono text-accent/80">Drop file here</span>
        </div>
      )}
    </div>
  )
}
