import { describe, expect, it } from 'vitest'
import type { BatchAction } from './batch-actions'
import { buildClearableField, buildRunInput, isInputValid, type ReassignFields } from './batch-run-input'

const act = (requiresInput?: BatchAction['requiresInput']): BatchAction =>
  ({ id: 'x', label: 'X', requiresInput }) as BatchAction

const BLANK: ReassignFields = { project: '', sentinel: '', profile: '' }

describe('buildClearableField', () => {
  it('omits the key entirely when blank (leave unchanged)', () => {
    expect(buildClearableField('toProfile', '')).toEqual({})
  })

  it('sends an explicit null for the __clear__ token', () => {
    expect(buildClearableField('toProfile', '__clear__')).toEqual({ toProfile: null })
  })

  it('passes a real value through', () => {
    expect(buildClearableField('toHostSentinelId', 'snt_abc')).toEqual({ toHostSentinelId: 'snt_abc' })
  })
})

describe('buildRunInput', () => {
  it('wraps a broadcast message', () => {
    expect(buildRunInput(act('broadcast'), 'hello', BLANK)).toEqual({ message: 'hello' })
  })

  it('is undefined for an action with no form', () => {
    expect(buildRunInput(act(), 'ignored', BLANK)).toBeUndefined()
  })

  it('includes only the reassign fields that were filled in', () => {
    expect(buildRunInput(act('reassign'), '', { project: 'claude://p', sentinel: '', profile: '__clear__' })).toEqual({
      toProjectUri: 'claude://p',
      toProfile: null,
    })
  })

  it('is an empty payload when every reassign field is blank', () => {
    expect(buildRunInput(act('reassign'), '', BLANK)).toEqual({})
  })
})

describe('isInputValid', () => {
  it('is always true for an action with no form', () => {
    expect(isInputValid(act(), '', BLANK)).toBe(true)
  })

  it('needs a non-whitespace broadcast message', () => {
    expect(isInputValid(act('broadcast'), '   ', BLANK)).toBe(false)
    expect(isInputValid(act('broadcast'), ' hi ', BLANK)).toBe(true)
  })

  it('needs at least one reassign field', () => {
    expect(isInputValid(act('reassign'), '', BLANK)).toBe(false)
    expect(isInputValid(act('reassign'), '', { ...BLANK, profile: '__clear__' })).toBe(true)
  })
})
