import { describe, expect, it } from 'bun:test'
import { buildGuardPrompt, type GuardPromptCtx } from './guard-prompt'

const base: GuardPromptCtx = {
  projectUri: 'claude://sentinel/proj',
  projectRoot: '/Users/jonas/projects/proj',
  cardId: 'fix-the-thing',
}

describe('buildGuardPrompt', () => {
  it('injects the distrust stance and the card path', () => {
    const p = buildGuardPrompt(base)
    expect(p).toContain('THE GUARD')
    expect(p).toContain('do NOT trust')
    // The canonical card path -- NOT the lane it happens to be sitting in.
    expect(p).toContain('.rclaude/project/cards/fix-the-thing.md')
  })

  it('references the exact approve + bounce transitions for this card', () => {
    const p = buildGuardPrompt(base)
    expect(p).toContain('project_set_status(id="fix-the-thing", status="done")')
    expect(p).toContain('project_set_status(id="fix-the-thing", status="in-progress")')
  })

  it('tells the Guard to re-run test_cmd and acceptance itself', () => {
    const p = buildGuardPrompt(base)
    expect(p).toContain('Re-run `test_cmd`')
    expect(p).toContain('acceptance')
  })

  it('names the quest when provided, omits the line otherwise', () => {
    expect(buildGuardPrompt({ ...base, quest: 'floppy-panda' })).toContain('floppy-panda')
    expect(buildGuardPrompt(base)).not.toContain('belongs to quest')
  })
})

/**
 * THE SEAT LEASE IS EPIC-ONLY. `epic_seat` is gated to WERK-launched seats, so
 * ordering a QUEST Guard to call it would hand every quest verification a 403 it
 * can do nothing about -- and an instruction that reliably fails is how an agent
 * learns to ignore instructions.
 */
describe('the seat-lease order rides on epicId', () => {
  const epic = buildGuardPrompt({ ...base, epicId: 'epic-project-runner' })

  it('a QUEST Guard is never told to claim a seat', () => {
    const quest = buildGuardPrompt({ ...base, quest: 'floppy-panda' })
    expect(quest).not.toContain('epic_seat')
  })

  it('an EPIC Guard claims its VERIFIER seat, before it checks anything out', () => {
    expect(epic).toContain('epic_seat(action="claim")')
    expect(epic).toContain('verifier seat')
    expect(epic.indexOf('CLAIM YOUR SEAT FIRST')).toBeLessThan(epic.indexOf('INDEPENDENT VERIFICATION'))
  })

  it('and it is told the implementer on the same card is NOT a collision', () => {
    expect(epic).toContain('two DIFFERENT seats')
  })

  it('it gives the seat back once the verdict is written', () => {
    expect(epic).toContain('epic_seat(action="release")')
  })
})
