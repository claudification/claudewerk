import { VOICE_ORB_TONES, VOICE_ORB_VOICES } from '@shared/voice-orb-options'
import { describe, expect, it } from 'vitest'
import { nearestSpeedStep, ORB_SPEED_STEPS, speedLabel, TONE_LABEL, VOICE_LABEL } from './orb-menu-model'

describe('the orb menu speed steps', () => {
  it('labels a rate the way the slider does', () => {
    expect(speedLabel(1.5)).toBe('1.5x')
    expect(speedLabel(1)).toBe('1x')
    expect(speedLabel(1.15)).toBe('1.15x')
  })

  it('ticks the CLOSEST step, so a slider value off-grid still shows as set', () => {
    expect(nearestSpeedStep(1.28)).toBe(1.3)
    expect(nearestSpeedStep(1.05)).toBe(1.0)
    expect(nearestSpeedStep(1.45)).toBe(1.5)
  })

  it('clamps out-of-range and junk instead of ticking nothing', () => {
    expect(nearestSpeedStep(9)).toBe(1.5)
    expect(nearestSpeedStep(0.1)).toBe(0.9)
    expect(nearestSpeedStep('nonsense')).toBe(1.3)
    expect(nearestSpeedStep(undefined)).toBe(1.3)
  })

  it('never offers a rate the API would reject', () => {
    for (const step of ORB_SPEED_STEPS) {
      expect(step).toBeGreaterThanOrEqual(0.25)
      expect(step).toBeLessThanOrEqual(1.5)
    }
  })
})

describe('the voice + tone labels', () => {
  it('has a label for every voice the API accepts -- no bare id ever shown', () => {
    for (const voice of VOICE_ORB_VOICES) {
      expect(VOICE_LABEL[voice], `voice ${voice} has no label`).toBeTruthy()
    }
  })

  it('has a label for every tone', () => {
    for (const tone of VOICE_ORB_TONES) {
      expect(TONE_LABEL[tone], `tone ${tone} has no label`).toBeTruthy()
    }
  })
})
