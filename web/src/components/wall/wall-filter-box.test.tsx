/**
 * W2, the one query box:
 *
 *  - `/` focuses it from anywhere on the wall, `Esc` leaves it
 *  - a `/` typed INSIDE it is a slash, not a hotkey
 *  - Escape in the box does not also drop ambient -- one key, two steps
 *  - it is bound to the shared store in both directions, so the chip action
 *    (`toggleProject`) shows up as text a human could have typed
 *  - the query survives inline -> docked -> detached -> ambient, AND a full
 *    dispose/rebuild of the surface body, which is the transition local state
 *    would actually lose
 */

import { fireEvent } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallFilterStore } from '@/lib/wall/filter'
import { openWall, useWallStore, WALL_MODAL } from './wall-state'
import { installWallTestHooks, openTheWall, store, wallRoot } from './wall-test-utils'

installWallTestHooks()
beforeEach(() => {
  useWallFilterStore.getState().clear()
})

const filterBox = (doc: Document = document): HTMLInputElement => {
  const input = wallRoot(doc).querySelector('.wall-filter input')
  if (!input) throw new Error('the filter box never mounted')
  return input as HTMLInputElement
}

/** Type into the box the way the user does -- through the DOM, not the store. */
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } })

describe('the wall filter box', () => {
  it('focuses on `/` and blurs on Escape', async () => {
    await openTheWall()
    const input = filterBox()

    fireEvent.keyDown(document, { key: '/' })
    expect(document.activeElement).toBe(input)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.activeElement).not.toBe(input)
  })

  it('leaves a `/` typed inside the box alone', async () => {
    await openTheWall()
    const input = filterBox()
    input.focus()

    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    // Not swallowed: the browser is free to insert the character.
    expect(event.defaultPrevented).toBe(false)
  })

  it('spends Escape on the box before it spends it on ambient', async () => {
    await openTheWall()
    const input = filterBox()

    fireEvent.keyDown(document, { key: 'a' })
    expect(useWallStore.getState().ambient).toBe(true)

    fireEvent.keyDown(document, { key: '/' })
    fireEvent.keyDown(input, { key: 'Escape' })
    // First Escape left the box...
    expect(document.activeElement).not.toBe(input)
    expect(useWallStore.getState().ambient).toBe(true)

    // ...the second one leaves ambient.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useWallStore.getState().ambient).toBe(false)
  })

  it('is bound to the one store in both directions', async () => {
    await openTheWall()
    const input = filterBox()

    type(input, 'ceiling @rc %70')
    expect(useWallFilterStore.getState().raw).toBe('ceiling @rc %70')
    expect(useWallFilterStore.getState().query.project).toBe('rc')
    expect(useWallFilterStore.getState().query.minContextPct).toBe(70)

    // The chip action writes the same string a human would have typed, and the
    // box shows it -- that is what makes it editable and clearable by hand.
    act(() => {
      useWallFilterStore.getState().toggleProject('anvil')
    })
    expect(input.value).toBe('ceiling %70 @anvil')
  })

  it('keeps the query across docked, detached and ambient', async () => {
    const doc = document.implementation.createHTMLDocument('wall popout')
    const fakeWin = { document: doc, focus: vi.fn(), close: vi.fn(), closed: false }
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window)

    await openTheWall()
    type(filterBox(), '@rc !!')

    act(() => {
      store().minimize(WALL_MODAL.id)
    })
    act(() => {
      store().restore(WALL_MODAL.id)
    })
    expect(filterBox().value).toBe('@rc !!')

    act(() => {
      store().detach(WALL_MODAL.id)
    })
    // Same box, other document -- and the `/` listener followed it there. The
    // assertion is `defaultPrevented` rather than focus because a document with
    // no browsing context cannot hold an activeElement: jsdom's focus() is a
    // no-op there, so a focus assertion would be testing jsdom, not the wiring.
    const detached = filterBox(doc)
    expect(detached.value).toBe('@rc !!')
    const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    doc.dispatchEvent(slash)
    expect(slash.defaultPrevented).toBe(true)

    act(() => {
      store().reattach(WALL_MODAL.id)
    })
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(filterBox().value).toBe('@rc !!')
  })

  it('survives the surface being disposed and rebuilt', async () => {
    await openTheWall()
    type(filterBox(), '@rc #wip')

    // close() drops the canvas, so the body is genuinely rebuilt from scratch.
    // Anything the box held itself is gone here; the store is what is left.
    act(() => {
      store().close(WALL_MODAL.id)
    })
    act(() => {
      openWall()
    })
    expect(filterBox().value).toBe('@rc #wip')
  })
})
