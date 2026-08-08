/**
 * modelPickerValue -- runtime model id -> a value the picker can select.
 *
 * The failure being pinned: a Select handed a value matching no option renders
 * a BLANK trigger. Every one of these inputs is a real `conversation.model`
 * value observed live in the broker.
 */

import { DROPDOWN_MODEL_ENTRIES } from '@shared/models'
import { describe, expect, it } from 'vitest'
import { modelPickerValue } from './model-picker-value'

const ids = new Set(DROPDOWN_MODEL_ENTRIES.map(m => m.id))

describe('modelPickerValue', () => {
  it('always returns either "" or a real picker option -- never a blank control', () => {
    for (const slug of [
      'claude-opus-4-8[1m]',
      'claude-opus-4-7[1m]',
      'claude-opus-5[1m]',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-opus-4-6[1m]',
      'opus[1m]',
      'sonnet',
      'total-nonsense-model',
    ]) {
      const v = modelPickerValue(slug)
      expect(v === '' || ids.has(v), `${slug} -> ${v}`).toBe(true)
    }
  })

  it('passes a value that is already an option straight through', () => {
    expect(modelPickerValue('claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('maps a runtime 1M id onto its family option', () => {
    expect(modelPickerValue('claude-opus-4-8[1m]')).toBe('claude-opus-4-8')
  })

  it('maps a dated runtime id onto its family option', () => {
    expect(modelPickerValue('claude-haiku-4-5-20251001')).toBe('haiku')
  })

  it('keeps the 1M variant when the picker actually offers one', () => {
    expect(modelPickerValue('claude-opus-4-6[1m]')).toBe('claude-opus-4-6[1m]')
  })

  it('falls back to Default rather than an unselectable value', () => {
    expect(modelPickerValue('total-nonsense-model')).toBe('')
    expect(modelPickerValue(undefined)).toBe('')
    expect(modelPickerValue('')).toBe('')
  })
})
