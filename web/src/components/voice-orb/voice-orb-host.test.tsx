import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Line = { role: 'agent' | 'user'; text: string; partial: boolean }

const orb = {
  state: 'listening',
  error: null as string | null,
  lastLine: null as Line | null,
  lines: [] as Line[],
  muted: false,
  live: true,
  start: vi.fn(),
  stop: vi.fn(),
  toggleMute: vi.fn(),
  reload: vi.fn(),
  audioStreams: () => [],
  announce: vi.fn(),
  say: vi.fn(),
}
vi.mock('@/hooks/use-voice-orb', () => ({ useVoiceOrb: () => orb }))

const { VoiceOrbHost } = await import('./voice-orb-host')
const { voiceOrbBus } = await import('./voice-orb-bus')

const summon = () => act(() => voiceOrbBus.open('summon'))
const orbButton = () => screen.getByLabelText(/^Voice orb -- (open|close) the transcript$/)
/** The self-controls are a CONTEXT menu: right-click / long-press, never click. */
const openOrbMenu = () => fireEvent.contextMenu(orbButton())
const openTranscript = () => act(() => orbButton().click())

beforeEach(() => {
  orb.error = null
  orb.lastLine = null
  orb.lines = []
  orb.muted = false
  orb.state = 'listening'
  orb.start.mockClear()
  orb.stop.mockClear()
  orb.toggleMute.mockClear()
  orb.say.mockClear()
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

  it('CLICK opens the transcript, not the menu', () => {
    render(<VoiceOrbHost />)
    summon()
    expect(screen.queryByLabelText('Orb transcript')).toBeNull()
    openTranscript()
    expect(screen.getByLabelText('Orb transcript')).toBeTruthy()
    // The click must not have raised the self-controls as well.
    expect(screen.queryByText('Dismiss the orb')).toBeNull()
  })

  it('RIGHT-CLICK opens the self-controls -- every one of them', () => {
    render(<VoiceOrbHost />)
    summon()
    openOrbMenu()
    expect(screen.getByText('Open the desk')).toBeTruthy()
    expect(screen.getByText('Dismiss the orb')).toBeTruthy()
    // ...and it did NOT open the transcript.
    expect(screen.queryByLabelText('Orb transcript')).toBeNull()
  })

  it('types into the live session -- the whole point of the panel', () => {
    render(<VoiceOrbHost />)
    summon()
    openTranscript()
    const box = screen.getByPlaceholderText('Type or paste, Enter to send')
    fireEvent.change(box, { target: { value: '  conv_7f3a91  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    // Trimmed, because a pasted id drags whitespace in with it.
    expect(orb.say).toHaveBeenCalledWith('conv_7f3a91')
  })

  it('Shift+Enter is a newline, NOT a send -- pasting multi-line must survive', () => {
    render(<VoiceOrbHost />)
    summon()
    openTranscript()
    const box = screen.getByPlaceholderText('Type or paste, Enter to send')
    fireEvent.change(box, { target: { value: 'line one' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(orb.say).not.toHaveBeenCalled()
  })

  it('shows both sides of the conversation, oldest first', () => {
    orb.lines = [
      { role: 'user', text: 'status?', partial: false },
      { role: 'agent', text: 'four live, one wants you', partial: false },
    ]
    render(<VoiceOrbHost />)
    summon()
    openTranscript()
    expect(screen.getByText('four live, one wants you')).toBeTruthy()
    expect(screen.getByText('status?')).toBeTruthy()
  })

  it('the panel carries the menu too, for touch where long-press is a guess', () => {
    render(<VoiceOrbHost />)
    summon()
    openTranscript()
    fireEvent.pointerDown(screen.getByLabelText("Open the orb's menu"), { button: 0, ctrlKey: false })
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
