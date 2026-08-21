/**
 * The three Enter paths, pinned against a REAL editor.
 *
 * They are one key apart and mean three different things, so a regression in
 * any of them looks like the editor working: Enter files a card, Mod-Enter
 * files it tagged for a later pass, Shift+Enter types a newline. Nothing about
 * the modal makes a wrong one visible -- you find out when the card is on the
 * board without its tag, or when your second line submitted instead.
 *
 * Mod-Enter arriving as PLAIN submit is the specific failure this guards: CM6
 * keys bindings on the full modifier string, and if that ever stopped being
 * true, `Enter` would swallow the modified form and the tag would silently
 * never land.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, test } from 'vitest'
import { buildInputExtensions } from './extensions'
import { attachShiftEnterNewline, submitFromEditor } from './submit-keys'

/**
 * CM6 normalizes `Mod-` to Cmd on macOS and Ctrl everywhere else. Mirror its
 * own platform check so this asserts the binding the user gets on THIS machine
 * rather than a hardcoded guess (jsdom is not a Mac, so it is Ctrl in CI).
 */
const MOD_KEY: 'metaKey' | 'ctrlKey' = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  ? 'metaKey'
  : 'ctrlKey'

interface Fired {
  plain: string[]
  alt: string[]
}

let teardown: (() => void) | null = null
afterEach(() => {
  teardown?.()
  teardown = null
})

/** A Quick Task-shaped editor: both submit paths wired, Shift+Enter attached. */
function mountEditor(doc: string): { view: EditorView; fired: Fired } {
  const fired: Fired = { plain: [], alt: [] }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: buildInputExtensions({
        onSubmit: () => fired.plain.push(view.state.doc.toString()),
        onSubmitAlt: () => fired.alt.push(view.state.doc.toString()),
      }),
    }),
  })
  attachShiftEnterNewline(view)
  teardown = () => view.destroy()
  return { view, fired }
}

function pressEnter(view: EditorView, mods: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey', boolean>> = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, ...mods }),
  )
}

test('Enter submits plain -- no alternate, doc cleared', () => {
  const { view, fired } = mountEditor('rough thought')
  pressEnter(view)

  expect(fired.plain).toEqual(['rough thought'])
  expect(fired.alt).toEqual([])
  expect(view.state.doc.toString()).toBe('')
})

test('Mod-Enter fires the ALTERNATE submit, never the plain one', () => {
  const { view, fired } = mountEditor('rough thought')
  pressEnter(view, { [MOD_KEY]: true })

  expect(fired.alt).toEqual(['rough thought'])
  expect(fired.plain).toEqual([])
  expect(view.state.doc.toString()).toBe('')
})

test('Shift+Enter inserts a newline and submits nothing', () => {
  const { view, fired } = mountEditor('first line')
  view.dispatch({ selection: { anchor: view.state.doc.length } })
  pressEnter(view, { shiftKey: true })

  expect(view.state.doc.toString()).toBe('first line\n')
  expect(fired.plain).toEqual([])
  expect(fired.alt).toEqual([])
})

test('no alternate submit callback means NO Mod-Enter binding at all', () => {
  const fired: string[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc: 'prompt text',
      // The prompt input's shape: one submit path, nothing else.
      extensions: buildInputExtensions({ onSubmit: () => fired.push('plain') }),
    }),
  })
  teardown = () => view.destroy()

  pressEnter(view, { [MOD_KEY]: true })

  // Nothing of OURS runs: the key falls through to CM's own defaultKeymap
  // (Mod-Enter is insertBlankLine there), which is exactly the untouched
  // behaviour the prompt input has today.
  expect(fired).toEqual([])
  expect(view.state.doc.toString()).toContain('prompt text')
})

test('submitFromEditor clears after the callback, for either path', () => {
  const { view } = mountEditor('typed')
  let seen: string | null = null
  submitFromEditor(view, () => {
    seen = view.state.doc.toString()
  })

  expect(seen).toBe('typed')
  expect(view.state.doc.toString()).toBe('')
})
