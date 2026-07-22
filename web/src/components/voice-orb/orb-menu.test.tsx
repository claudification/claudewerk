import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrbMenu, OrbMenuButton } from './orb-menu'

const actions = () => ({
  muted: false,
  toggleMute: vi.fn(),
  reload: vi.fn(),
  dismiss: vi.fn(),
  openDesk: vi.fn(),
})

const orb = () => screen.getByRole('button', { name: 'orb' })

/** The orb's menu is a CONTEXT menu now -- right-click, not click. */
function rightClickOrb() {
  return !fireEvent.contextMenu(orb())
}

afterEach(cleanup)

describe('the orb menu opens on right-click, NOT on click', () => {
  it('leaves the plain click alone, so the transcript can have it', () => {
    const onClick = vi.fn()
    render(
      <OrbMenu actions={actions()}>
        <button type="button" onClick={onClick}>
          orb
        </button>
      </OrbMenu>,
    )
    // Radix's DropdownMenu.Trigger used to open on POINTERDOWN. This must not.
    fireEvent.pointerDown(orb(), { button: 0, ctrlKey: false })
    fireEvent.click(orb())
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Dismiss the orb')).toBeNull()
  })

  it('does not claim Enter either -- the keyboard route to the transcript', () => {
    const onClick = vi.fn()
    render(
      <OrbMenu actions={actions()}>
        <button type="button" onClick={onClick}>
          orb
        </button>
      </OrbMenu>,
    )
    fireEvent.keyDown(orb(), { key: 'Enter' })
    expect(screen.queryByText('Dismiss the orb')).toBeNull()
  })

  it('opens on right-click, without the browser menu, and carries every self-control', () => {
    render(
      <OrbMenu actions={actions()}>
        <button type="button">orb</button>
      </OrbMenu>,
    )
    expect(rightClickOrb()).toBe(true)
    expect(screen.getByText('Open the desk')).toBeTruthy()
    expect(screen.getByText('Mute the mic')).toBeTruthy()
    expect(screen.getByText('Restart the orb')).toBeTruthy()
    expect(screen.getByText('Dismiss the orb')).toBeTruthy()
    // The rate is reachable from the orb itself, not only from Settings.
    expect(screen.getByText('Speaking rate')).toBeTruthy()
    expect(screen.getByText('1.5x')).toBeTruthy()
    // ...and so are the voice and tone dials, each a one-tap-deep submenu.
    expect(screen.getByText('Voice')).toBeTruthy()
    expect(screen.getByText('Tone')).toBeTruthy()
  })

  it('runs the action it was asked for', () => {
    const a = actions()
    render(
      <OrbMenu actions={a}>
        <button type="button">orb</button>
      </OrbMenu>,
    )
    rightClickOrb()
    fireEvent.click(screen.getByText('Dismiss the orb'))
    expect(a.dismiss).toHaveBeenCalled()
  })

  it('reads back MUTED so the menu says how to undo it', () => {
    render(
      <OrbMenu actions={{ ...actions(), muted: true }}>
        <button type="button">orb</button>
      </OrbMenu>,
    )
    rightClickOrb()
    expect(screen.getByText('Unmute the mic')).toBeTruthy()
  })
})

describe('the same menu from an explicit button', () => {
  it('opens from the transcript header and offers the identical rows', () => {
    const a = actions()
    render(<OrbMenuButton actions={a} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: "Open the orb's menu" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByText('Open the desk')).toBeTruthy()
    expect(screen.getByText('Speaking rate')).toBeTruthy()
    fireEvent.click(screen.getByText('Restart the orb'))
    expect(a.reload).toHaveBeenCalled()
  })

  it('announces itself as a menu button -- the aria the orb itself must NOT claim', () => {
    render(<OrbMenuButton actions={actions()} />)
    expect(screen.getByRole('button', { name: "Open the orb's menu" }).getAttribute('aria-haspopup')).toBe('menu')
  })
})
