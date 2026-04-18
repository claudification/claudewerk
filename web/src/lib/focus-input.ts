/**
 * Backend-agnostic focus helper for the InputEditor.
 *
 * Legacy backend uses a real <textarea>; CodeMirror backend uses a
 * contentEditable inside .cm-editor. Either is "the input" -- this
 * helper finds and focuses whichever exists in the given root.
 *
 * Falls back gracefully: returns true on success, false if no input was
 * found in scope.
 */

export function focusInputEditor(root: ParentNode = document): boolean {
  // CM backend: contentEditable inside .cm-editor (also matches focus-trapped
  // mobile compose panel, since it portals to body but its descendants are
  // still reachable from document).
  const cm = root.querySelector<HTMLElement>('.cm-editor [contenteditable="true"]')
  if (cm) {
    cm.focus()
    return true
  }
  const ta = root.querySelector<HTMLTextAreaElement>('textarea')
  if (ta) {
    ta.focus()
    return true
  }
  return false
}
