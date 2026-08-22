import { describe, expect, it } from 'bun:test'
import { buildWerkVerifierPrompt, type WerkVerifierPromptCtx } from './epic-prompt-werk-verifier'

const base: WerkVerifierPromptCtx = {
  projectUri: 'claude://sentinel/proj',
  projectRoot: '/Users/jonas/projects/proj',
  cardId: 'fix-the-thing',
}

describe('buildWerkVerifierPrompt', () => {
  it('injects the distrust stance and the card path', () => {
    const p = buildWerkVerifierPrompt(base)
    expect(p).toContain('THE GUARD')
    expect(p).toContain('do NOT trust')
    // The canonical card path -- NOT the lane it happens to be sitting in.
    expect(p).toContain('.rclaude/project/cards/fix-the-thing.md')
  })

  it('references the exact approve + bounce transitions for this card', () => {
    const p = buildWerkVerifierPrompt(base)
    expect(p).toContain('project_set_status(id="fix-the-thing", status="done")')
    expect(p).toContain('project_set_status(id="fix-the-thing", status="in-progress")')
  })

  it('tells the Guard to re-run test_cmd and acceptance itself', () => {
    const p = buildWerkVerifierPrompt(base)
    expect(p).toContain('Re-run `test_cmd`')
    expect(p).toContain('acceptance')
  })

  it('names the quest when provided, omits the line otherwise', () => {
    expect(buildWerkVerifierPrompt({ ...base, quest: 'floppy-panda' })).toContain('floppy-panda')
    expect(buildWerkVerifierPrompt(base)).not.toContain('belongs to quest')
  })
})

/**
 * THE SEAT LEASE IS EPIC-ONLY. `epic_seat` is gated to WERK-launched seats, so
 * ordering a QUEST Guard to call it would hand every quest verification a 403 it
 * can do nothing about -- and an instruction that reliably fails is how an agent
 * learns to ignore instructions.
 */
describe('the seat-lease order rides on epicId', () => {
  const epic = buildWerkVerifierPrompt({ ...base, epicId: 'epic-project-runner' })

  it('a QUEST Guard is never told to claim a seat', () => {
    const quest = buildWerkVerifierPrompt({ ...base, quest: 'floppy-panda' })
    expect(quest).not.toContain('epic_seat')
  })

  it('an EPIC Guard claims its WERK-VERIFIER seat, before it checks anything out', () => {
    expect(epic).toContain('epic_seat(action="claim")')
    expect(epic).toContain('werk-verifier seat')
    expect(epic.indexOf('CLAIM YOUR SEAT FIRST')).toBeLessThan(epic.indexOf('INDEPENDENT VERIFICATION'))
  })

  it('and it is told the werk-worker on the same card is NOT a collision', () => {
    expect(epic).toContain('two DIFFERENT seats')
  })

  it('it gives the seat back once the verdict is written', () => {
    expect(epic).toContain('epic_seat(action="release")')
  })
})
