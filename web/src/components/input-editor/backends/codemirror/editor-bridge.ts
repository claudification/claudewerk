/**
 * CM-free bridge between non-CodeMirror code and the (lazy) CM input backend.
 *
 * LAZY-LOAD COVENANT: this module imports ZERO CodeMirror. It exists so the
 * input hot path (e.g. conversation-input.tsx, which only needs to push a
 * value into the editor) can talk to the CM backend WITHOUT statically
 * dragging the entire @codemirror/* runtime (~900KB of source) into the eager
 * index chunk. The CM side lives behind a React.lazy boundary (./inner) and
 * listens for these events; when no CM editor is mounted the dispatch is a
 * harmless no-op (the legacy textarea handles value sync via React state).
 *
 * Keep this file dependency-free. Adding a CM import here re-introduces the
 * exact leak it was created to kill.
 */

/**
 * Fire-and-forget bridge for non-CM code (e.g. InputBar) to set the CM
 * editor's content instantly. The CM backend listens for this event and
 * calls replaceEditorDoc. Falls through silently when no CM is mounted
 * (legacy textarea handles it via React state).
 */
export function requestEditorSetValue(text: string) {
  window.dispatchEvent(new CustomEvent('editor-set-value', { detail: text }))
}
