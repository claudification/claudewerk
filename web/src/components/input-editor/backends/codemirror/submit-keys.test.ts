/**
 * The two Enter paths, pinned against a REAL editor.
 *
 * They are one modifier apart and mean different things, so a regression in
 * either looks like the editor working: Enter files a card, Shift+Enter types a
 * newline. Nothing about the modal makes a wrong one visible -- you find out
 * when your second line submitted instead of wrapping.
 *
 * There was briefly a third, `Mod-Enter`, filing the capture tagged
 * `needs-refine`. Removed 2026-08-21: it did not fire for the user, and a
 * modifier chord is the wrong shape for that job regardless -- invisible, and
 * unreachable on a touchscreen. The last test here pins the consequence: a
 * modified Enter must now do nothing of OURS, on every surface.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, test } from 'vitest'
import { buildInputExtensions } from './extensions'
import { attachShiftEnterNewline, submitFromEditor } from './submit-keys'

/**
 * CM6 normalizes `Mod-` to Cmd on macOS and Ctrl everywhere else. Mirror its own
 * platform check so this asserts what the user gets on THIS machine rather than
 * a hardcoded guess (jsdom is not a Mac, so it is Ctrl in CI).
 */
const MOD_KEY: 'metaKey' | 'ctrlKey' = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  ? 'metaKey'
  : 'ctrlKey'

let teardown: (() => void) | null = null
afterEach(() => {
  teardown?.()
  teardown = null
})

/** A Quick Task-shaped editor: submit wired, Shift+Enter attached. */
function mountEditor(doc: string): { view: EditorView; fired: string[] } {
  const fired: string[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: buildInputExtensions({ onSubmit: () => fired.push(view.state.doc.toString()) }),
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

test('Enter submits and clears the doc', () => {
  const { view, fired } = mountEditor('rough thought')
  pressEnter(view)

  expect(fired).toEqual(['rough thought'])
  expect(view.state.doc.toString()).toBe('')
})

test('Shift+Enter inserts a newline and submits nothing', () => {
  const { view, fired } = mountEditor('first line')
  view.dispatch({ selection: { anchor: view.state.doc.length } })
  pressEnter(view, { shiftKey: true })

  expect(view.state.doc.toString()).toBe('first line\n')
  expect(fired).toEqual([])
})

test('Mod-Enter no longer submits anything -- the chord is gone', () => {
  const { view, fired } = mountEditor('rough thought')
  pressEnter(view, { [MOD_KEY]: true })

  // CM6 keys bindings on the FULL modifier string, so a modified Enter never
  // falls through to the plain `Enter` handler. Re-adding a Mod-Enter binding
  // anywhere would break this and should be a deliberate decision, not a
  // side-effect.
  expect(fired).toEqual([])
  expect(view.state.doc.toString()).toContain('rough thought')
})

test('submitFromEditor clears AFTER the callback reads the doc', () => {
  const { view } = mountEditor('typed')
  let seen: string | null = null
  submitFromEditor(view, () => {
    seen = view.state.doc.toString()
  })

  expect(seen).toBe('typed')
  expect(view.state.doc.toString()).toBe('')
})
