import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrbMenu } from './orb-menu'

const actions = () => ({
  muted: false,
  toggleMute: vi.fn(),
  reload: vi.fn(),
  dismiss: vi.fn(),
  openDesk: vi.fn(),
})

/** Radix opens its trigger on POINTERDOWN, not click. */
function openMenu() {
  fireEvent.pointerDown(screen.getByRole('button'), { button: 0, ctrlKey: false })
}

afterEach(cleanup)

describe('the orb menu', () => {
  it('opens on a plain click/tap and carries every self-control', () => {
    render(
      <OrbMenu actions={actions()}>
        <button type="button">orb</button>
      </OrbMenu>,
    )
    openMenu()
    expect(screen.getByText('Open the desk')).toBeTruthy()
    expect(screen.getByText('Mute the mic')).toBeTruthy()
    expect(screen.getByText('Restart the orb')).toBeTruthy()
    expect(screen.getByText('Dismiss the orb')).toBeTruthy()
    // The rate is reachable from the orb itself, not only from Settings.
    expect(screen.getByText('Speaking rate')).toBeTruthy()
    expect(screen.getByText('1.5x')).toBeTruthy()
  })

  it('opens on RIGHT-CLICK too, without the browser menu', () => {
    render(
      <OrbMenu actions={actions()}>
        <button type="button">orb</button>
      </OrbMenu>,
    )
    const prevented = !fireEvent.contextMenu(screen.getByRole('button'))
    expect(prevented).toBe(true)
    expect(screen.getByText('Open the desk')).toBeTruthy()
  })

  it('dismiss runs the dismiss action', () => {
    const a = actions()
    render(
      <OrbMenu actions={a}>
        <button type="button">orb</button>
      </OrbMenu>,
    )
    openMenu()
    fireEvent.click(screen.getByText('Dismiss the orb'))
    expect(a.dismiss).toHaveBeenCalled()
  })

  it('reads back MUTED so the menu says how to undo it', () => {
    render(
      <OrbMenu actions={{ ...actions(), muted: true }}>
        <button type="button">orb</button>
      </OrbMenu>,
    )
    openMenu()
    expect(screen.getByText('Unmute the mic')).toBeTruthy()
  })
})
