/**
 * The keys that END a capture, and the doc mutations they perform.
 *
 * Split out of `extensions.ts` (a 550-line composer) at the seam between "what
 * extensions does this editor get" and "what happens to the document when a
 * submit key lands". These are the pieces tested directly.
 *
 * Two Enter paths, deliberately distinct:
 *   - Enter       -> plain submit (`submitKeymap`, still composed in extensions.ts)
 *   - Shift+Enter -> newline (`attachShiftEnterNewline`, a DOM listener)
 *
 * There was briefly a third, `Mod-Enter`, filing a Quick Task capture tagged
 * `needs-refine`. It was REMOVED 2026-08-21: it did not fire for the user, and
 * a modifier chord is the wrong shape for that job anyway -- invisible, and
 * unreachable on a touchscreen. The tag is offered at the top of the `#` picker
 * instead (see `board-system-tags.ts`).
 */

import { type EditorView, keymap } from '@codemirror/view'

export function clearEditorDoc(view: EditorView) {
  const len = view.state.doc.length
  if (len > 0) view.dispatch({ changes: { from: 0, to: len, insert: '' } })
}

export function replaceEditorDoc(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
  })
}

export function submitFromEditor(view: EditorView, onSubmit: () => void) {
  // ORDER MATTERS: submit BEFORE clearing. @uiw/react-codemirror's onChange
  // fires SYNCHRONOUSLY off the clear's docChanged transaction. A consumer
  // whose onSubmit reads a live external store (the dispatcher: submit() reads
  // get().intent, which onChange writes) would otherwise see the just-cleared
  // '' and bail -- the "dead input" bug. The main chat dodged it only by
  // reading a stale React closure. Submitting first means every consumer reads
  // the typed text; the clear then resets the visible doc instantly (still
  // bypassing react-codemirror's 200ms typing latch).
  onSubmit()
  clearEditorDoc(view)
}

/**
 * Shift+Enter -> newline, registered directly on contentDOM in capture phase.
 *
 * CM6's InputState.handleEvent blocks ALL keydown events during active
 * composition (ignoreDuringComposition). On iOS, predictive text keeps
 * composition alive across modifier keys -- so Shift+Enter arrives while
 * composing and CM6 silently drops it before any keymap or domEventHandler
 * fires. This capture-phase listener runs before CM6's own bubble-phase
 * handler, sidestepping the composition gate entirely.
 *
 * A keymap entry would NOT do: that is the whole point of the DOM listener.
 */
export function attachShiftEnterNewline(view: EditorView) {
  view.contentDOM.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch(view.state.replaceSelection(view.state.lineBreak), {
          scrollIntoView: true,
          userEvent: 'input',
        })
      }
    },
    { capture: true },
  )
}
