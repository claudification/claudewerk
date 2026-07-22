import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const orb = {
  state: 'listening',
  error: null as string | null,
  lastLine: null as { role: string; text: string; partial: boolean } | null,
  muted: false,
  live: true,
  start: vi.fn(),
  stop: vi.fn(),
  toggleMute: vi.fn(),
  reload: vi.fn(),
  audioStreams: () => [],
}
vi.mock('@/hooks/use-voice-orb', () => ({ useVoiceOrb: () => orb }))

const { VoiceOrbHost } = await import('./voice-orb-host')
const { voiceOrbBus } = await import('./voice-orb-bus')

const summon = () => act(() => voiceOrbBus.open('summon'))
/** Radix opens its trigger on POINTERDOWN, not click. */
const openOrbMenu = () =>
  fireEvent.pointerDown(screen.getByLabelText('Voice orb -- open its menu'), { button: 0, ctrlKey: false })

beforeEach(() => {
  orb.error = null
  orb.lastLine = null
  orb.muted = false
  orb.state = 'listening'
  orb.start.mockClear()
  orb.stop.mockClear()
  orb.toggleMute.mockClear()
})
afterEach(() => {
  cleanup()
  voiceOrbBus.setHandler(null)
})

describe('VoiceOrbHost', () => {
  it('renders nothing until summoned', () => {
    const { container } = render(<VoiceOrbHost />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the orb, labelled with what it is doing', () => {
    render(<VoiceOrbHost />)
    summon()
    expect(screen.getByLabelText('Voice orb -- listening')).toBeTruthy()
    expect(orb.start).toHaveBeenCalled()
  })

  it('captions the last spoken line', () => {
    orb.lastLine = { role: 'agent', text: 'three conversations are working', partial: false }
    render(<VoiceOrbHost />)
    summon()
    expect(screen.getByTitle('three conversations are working')).toBeTruthy()
  })

  it('an error takes over the caption', () => {
    orb.error = 'microphone permission denied'
    orb.lastLine = { role: 'agent', text: 'stale line', partial: false }
    render(<VoiceOrbHost />)
    summon()
    expect(screen.getByTitle('microphone permission denied')).toBeTruthy()
  })

  it('the ORB IS the menu -- every self-control hangs off it', () => {
    render(<VoiceOrbHost />)
    summon()
    // No more bare text buttons floating beside it; one surface, opened by
    // clicking (or right-clicking) the orb itself.
    expect(screen.getByLabelText('Voice orb -- open its menu')).toBeTruthy()
    openOrbMenu()
    // The orb is not a second transcript surface -- it opens the text face.
    expect(screen.getByText('Open the desk')).toBeTruthy()
    expect(screen.getByText('Dismiss the orb')).toBeTruthy()
  })

  it('dismissing STOPS the session -- the mic must not stay hot', () => {
    render(<VoiceOrbHost />)
    summon()
    openOrbMenu()
    act(() => screen.getByText('Dismiss the orb').click())
    expect(orb.stop).toHaveBeenCalled()
    expect(screen.queryByLabelText(/Voice orb --/)).toBeNull()
  })

  it('mute toggles, and a muted orb reads as asleep', () => {
    const { rerender } = render(<VoiceOrbHost />)
    summon()
    openOrbMenu()
    act(() => screen.getByText('Mute the mic').click())
    expect(orb.toggleMute).toHaveBeenCalled()
    orb.muted = true
    rerender(<VoiceOrbHost />)
    expect(screen.getByLabelText('Voice orb -- dozing')).toBeTruthy()
    openOrbMenu()
    expect(screen.getByText('Unmute the mic')).toBeTruthy()
  })
})
