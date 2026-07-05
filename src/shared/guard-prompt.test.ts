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
    expect(p).toContain('.rclaude/project/in-review/fix-the-thing.md')
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
