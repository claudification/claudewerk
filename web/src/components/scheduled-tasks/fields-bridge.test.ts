/**
 * Fields-bridge tests -- the "" vs undefined contract.
 *
 * This adapter is the seam between the editor form (empty strings) and the wire
 * (fields absent when there is no override). Getting it wrong means a schedule
 * silently pins `model: ""`, which is not a model, and the spawn fails at 03:00.
 */

import { describe, expect, test } from 'vitest'
import { applyFieldsPatch, toFieldsValue } from './fields-bridge'
import { blankDraft, type ScheduleDraft } from './use-schedule-draft'

function draft(over: Partial<ScheduleDraft['spawn']> = {}): ScheduleDraft {
  const base = blankDraft('claude:///p', '/p')
  return { ...base, spawn: { ...base.spawn, ...over } }
}

describe('toFieldsValue', () => {
  test('absent overrides read as empty strings for the form', () => {
    const value = toFieldsValue(draft())
    expect(value.model).toBe('')
    expect(value.effort).toBe('')
    expect(value.agent).toBe('')
    expect(value.permissionMode).toBe('')
    expect(value.maxBudgetUsd).toBe('')
  })

  test('set overrides come through', () => {
    const value = toFieldsValue(draft({ model: 'claude-haiku-4-5', effort: 'low', maxBudgetUsd: 5 }))
    expect(value.model).toBe('claude-haiku-4-5')
    expect(value.effort).toBe('low')
    expect(value.maxBudgetUsd).toBe('5')
  })

  test('headless defaults to true rather than undefined', () => {
    expect(toFieldsValue(draft()).headless).toBe(true)
    expect(toFieldsValue(draft({ headless: false })).headless).toBe(false)
  })

  test('the worktree checkbox reflects whether a branch is set', () => {
    expect(toFieldsValue(draft()).useWorktree).toBe(false)
    expect(toFieldsValue(draft({ worktree: 'feat/x' })).useWorktree).toBe(true)
    expect(toFieldsValue(draft({ worktree: 'feat/x' })).worktreeName).toBe('feat/x')
  })
})

describe('applyFieldsPatch', () => {
  test('an empty string CLEARS the override rather than pinning ""', () => {
    const next = applyFieldsPatch(draft({ model: 'claude-opus-5' }), { model: '' })
    expect(next.spawn.model).toBeUndefined()
    expect('model' in next.spawn && next.spawn.model !== undefined).toBe(false)
  })

  test('whitespace-only is also treated as cleared', () => {
    expect(applyFieldsPatch(draft({ agent: 'x' }), { agent: '   ' }).spawn.agent).toBeUndefined()
  })

  test('sets a real value', () => {
    expect(applyFieldsPatch(draft(), { model: 'claude-haiku-4-5' }).spawn.model).toBe('claude-haiku-4-5')
  })

  test('numbers parse, and empty clears', () => {
    expect(applyFieldsPatch(draft(), { maxBudgetUsd: '12.5' }).spawn.maxBudgetUsd).toBe(12.5)
    expect(applyFieldsPatch(draft({ maxBudgetUsd: 5 }), { maxBudgetUsd: '' }).spawn.maxBudgetUsd).toBeUndefined()
  })

  test('non-numeric input clears rather than storing NaN', () => {
    expect(applyFieldsPatch(draft(), { maxBudgetUsd: 'abc' }).spawn.maxBudgetUsd).toBeUndefined()
  })

  test('only the keys present in the patch are touched', () => {
    const next = applyFieldsPatch(draft({ model: 'claude-opus-5', effort: 'high' }), { agent: 'reviewer' })
    expect(next.spawn.model).toBe('claude-opus-5')
    expect(next.spawn.effort).toBe('high')
    expect(next.spawn.agent).toBe('reviewer')
  })

  test('unchecking the worktree box clears the branch', () => {
    expect(applyFieldsPatch(draft({ worktree: 'feat/x' }), { useWorktree: false }).spawn.worktree).toBeUndefined()
  })

  test('checking it alone does not invent a branch name', () => {
    expect(applyFieldsPatch(draft(), { useWorktree: true }).spawn.worktree).toBeUndefined()
  })

  test('does not mutate the input draft', () => {
    const original = draft({ model: 'claude-opus-5' })
    applyFieldsPatch(original, { model: 'claude-haiku-4-5' })
    expect(original.spawn.model).toBe('claude-opus-5')
  })

  test('round-trips through the form without drift', () => {
    const start = draft({ model: 'claude-haiku-4-5', effort: 'low', worktree: 'feat/x' })
    const round = applyFieldsPatch(start, toFieldsValue(start))
    expect(round.spawn).toEqual(start.spawn)
  })
})
