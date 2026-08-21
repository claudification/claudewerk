/**
 * The keys that END a capture, and the doc mutations they perform.
 *
 * Split out of `extensions.ts` (a 550-line composer) at the seam between "what
 * extensions does this editor get" and "what happens to the document when a
 * submit key lands". These are the pieces tested directly.
 *
 * Three Enter paths, deliberately distinct:
 *   - Enter       -> plain submit (`submitKeymap`, still composed in extensions.ts)
 *   - Mod-Enter   -> the caller's ALTERNATE submit, opt-in (`altSubmitKeymap`)
 *   - Shift+Enter -> newline (`attachShiftEnterNewline`, a DOM listener)
 */

import type { Extension } from '@codemirror/state'
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
 * `Mod-Enter` -> a SECOND submit with different meaning (Quick Task files the
 * card tagged `needs-refine`). CM6 normalizes `Mod-` to Cmd on macOS and Ctrl
 * everywhere else, so one binding covers both.
 *
 * OPT-IN: callers that pass no alternate submit get no binding at all, which is
 * what keeps the prompt input on exactly one submit path.
 */
export function altSubmitKeymap(onSubmitAlt: () => void): Extension {
  return keymap.of([
    {
      key: 'Mod-Enter',
      run: view => {
        if (view.composing) return false
        submitFromEditor(view, onSubmitAlt)
        return true
      },
      preventDefault: true,
    },
  ])
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
