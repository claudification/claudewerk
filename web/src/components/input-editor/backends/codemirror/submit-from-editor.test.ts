import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { submitFromEditor } from './extensions'

// Reproduces the dispatcher "dead input" at the smallest faithful scope.
//
// @uiw/react-codemirror wires the React `onChange` prop through a CM6
// updateListener that fires SYNCHRONOUSLY with the new doc string on every
// docChanged transaction. So whatever `submitFromEditor` does to the doc before
// it calls `onSubmit` is observable by the consumer's onChange *first*.
//
// Two kinds of consumer:
//   - main chat  : onSubmit (handleSend) reads `inputValue` from a STALE React
//                  closure -> immune to a same-tick onChange('').
//   - dispatcher : onSubmit (store.submit) reads `get().intent` LIVE from a
//                  synchronous zustand store that onChange writes to -> a clear
//                  that fires onChange('') BEFORE onSubmit wipes intent first,
//                  and submit() bails on the now-empty draft. Dead input.
//
// We model the dispatcher exactly: an external store written by onChange and
// read by onSubmit.

function mountStoreBackedEditor() {
  let stored = ''
  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        EditorView.updateListener.of(u => {
          // Mirror @uiw/react-codemirror: push the doc string out on doc change.
          if (u.docChanged) stored = u.state.doc.toString()
        }),
      ],
    }),
  })
  return { view, getStored: () => stored, destroy: () => view.destroy() }
}

describe('submitFromEditor — store-backed (dispatcher) consumer', () => {
  let teardown: (() => void) | null = null
  afterEach(() => {
    teardown?.()
    teardown = null
  })

  it('onSubmit observes the typed text, not the just-cleared doc', () => {
    const { view, getStored, destroy } = mountStoreBackedEditor()
    teardown = destroy

    // User types "ship it".
    view.dispatch({ changes: { from: 0, insert: 'ship it' } })
    expect(getStored()).toBe('ship it')

    // Enter / the Send button route through submitFromEditor. The dispatcher's
    // onSubmit reads the live store value at call time.
    let seenBySubmit: string | null = null
    submitFromEditor(view, () => {
      seenBySubmit = getStored()
    })

    // THE BUG: on main, clearEditorDoc runs first -> onChange('') -> store=''
    // -> onSubmit sees '' -> submit() bails. This assertion fails on main.
    expect(seenBySubmit).toBe('ship it')
    // And the editor still clears after the submit fires.
    expect(getStored()).toBe('')
  })
})

// Guard the working main-chat path: a consumer whose onSubmit reads a value
// captured BEFORE the submit (stale React closure) must keep working, and the
// doc must still clear. Proves the fix doesn't regress conversation-input.
describe('submitFromEditor — closure-backed (main chat) consumer', () => {
  let teardown: (() => void) | null = null
  afterEach(() => {
    teardown?.()
    teardown = null
  })

  it('fires onSubmit with the captured text and clears the doc', () => {
    let docOut = ''
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorView.updateListener.of(u => {
            if (u.docChanged) docOut = u.state.doc.toString()
          }),
        ],
      }),
    })
    teardown = () => view.destroy()

    view.dispatch({ changes: { from: 0, insert: 'hello world' } })
    const captured = docOut // the stale-closure snapshot the main input reads

    let fired = false
    submitFromEditor(view, () => {
      fired = true
      expect(captured).toBe('hello world')
    })

    expect(fired).toBe(true)
    expect(docOut).toBe('')
  })
})
