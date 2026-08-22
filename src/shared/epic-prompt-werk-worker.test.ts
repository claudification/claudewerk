import { describe, expect, test } from 'bun:test'
import { buildWerkWorkerPrompt, type WerkWorkerPromptCtx } from './epic-prompt-werk-worker'

const CTX: WerkWorkerPromptCtx = {
  projectUri: 'claude://sentinel/Users/jonas/projects/remote-claude',
  projectRoot: '/Users/jonas/projects/remote-claude',
  epicId: 'epic-the-wall-ii',
  cardId: 'wall-commit-detail-in-wall',
  branch: 'epic/epic-the-wall-ii/wall-commit-detail-in-wall',
  base: 'main',
}

const withDeps = (...ids: string[]) =>
  buildWerkWorkerPrompt({
    ...CTX,
    dependsOn: ids.map(id => ({ id, branch: `worktree-epic/epic-the-wall-ii/${id}` })),
  })

describe('the base check appears exactly when there is a base to check', () => {
  test('a leaf card gets no dependency section at all', () => {
    const prompt = buildWerkWorkerPrompt(CTX)
    expect(prompt).not.toContain('DEPENDS ON WORK')
    expect(prompt).not.toContain('merge-base')
    expect(prompt).not.toContain('## Base')
  })

  test('an empty dependsOn is the same as none -- no noise from an empty array', () => {
    expect(buildWerkWorkerPrompt({ ...CTX, dependsOn: [] })).toBe(buildWerkWorkerPrompt(CTX))
  })

  test('a card with dependencies is told, by id AND by branch', () => {
    const prompt = withDeps('wall-navigation-and-hover')
    expect(prompt).toContain('wall-navigation-and-hover')
    expect(prompt).toContain('worktree-epic/epic-the-wall-ii/wall-navigation-and-hover')
  })

  test('every dependency is listed, not just the first', () => {
    const prompt = withDeps('dep-alpha', 'dep-bravo', 'dep-charlie')
    for (const id of ['dep-alpha', 'dep-bravo', 'dep-charlie']) {
      expect(prompt).toContain(`worktree-epic/epic-the-wall-ii/${id}`)
    }
  })
})

describe('what the section actually orders', () => {
  const prompt = withDeps('wall-navigation-and-hover')

  test('it says `done` is a lane, not a git fact -- the whole reason the check exists', () => {
    expect(prompt).toContain('`done` BY LANE')
  })

  test('it gives a check and a remedy, not just a warning', () => {
    expect(prompt).toContain('git merge-base --is-ancestor')
    expect(prompt).toContain('git merge <dep-branch>')
  })

  test('it orders the merge RECORDED on the card, with the commit', () => {
    expect(prompt).toContain('## Base')
    expect(prompt).toContain('git rev-parse --short <dep-branch>')
  })

  test('a conflict stops the werk-worker instead of letting it resolve blind', () => {
    expect(prompt).toContain('CONFLICTS, STOP')
    expect(prompt).toContain('needs-werk-master')
  })

  test('the check lands BEFORE the done/push protocol -- it is a before-you-code order', () => {
    expect(prompt.indexOf('DEPENDS ON WORK')).toBeLessThan(prompt.indexOf('WHEN THE WORK IS DONE'))
  })

  test('the rest of the prompt is untouched by the section', () => {
    expect(prompt).toContain('THERE IS NO HUMAN')
    expect(prompt).toContain('may not approve your own work')
  })
})

/**
 * THE SEAT ORDER. The claim only protects anything if it happens BEFORE there is
 * something to corrupt, so its position in the prompt is the property under
 * test, not merely its presence.
 */
describe('the seat claim comes first', () => {
  const prompt = buildWerkWorkerPrompt(CTX)

  test('the claim is ordered before the card is read and before any git work', () => {
    expect(prompt).toContain('epic_seat(action="claim")')
    expect(prompt.indexOf('CLAIM YOUR SEAT FIRST')).toBeLessThan(prompt.indexOf('YOUR CARD (read it first'))
    expect(prompt.indexOf('CLAIM YOUR SEAT FIRST')).toBeLessThan(prompt.indexOf('WORK RULES'))
  })

  /** A worker told only "claim your seat" reads an unreachable broker as a
   *  failure and stops -- which turns the mutex into an engine-wide halt. */
  test('all three answers are spelled out, including PROCEED on unreachable', () => {
    expect(prompt).toContain('REFUSED')
    expect(prompt).toContain('UNREACHABLE')
    expect(prompt).toContain('PROCEED WITH YOUR WORK')
  })

  test('a finished worker is told to give the seat back', () => {
    expect(prompt).toContain('epic_seat(action="release")')
    expect(prompt.indexOf('WHEN THE WORK IS DONE')).toBeLessThan(prompt.lastIndexOf('epic_seat(action="release")'))
  })

  test('a BLOCKED worker releases too, rather than sitting on the card until it dies', () => {
    expect(prompt.slice(prompt.indexOf('WHEN YOU ARE BLOCKED'))).toContain('epic_seat(action="release")')
  })
})

describe('werk-master constraints and the base check coexist', () => {
  test('both are emitted, constraints first', () => {
    const prompt = buildWerkWorkerPrompt({
      ...CTX,
      constraints: ['do not touch the wire protocol'],
      dependsOn: [{ id: 'dep-alpha', branch: 'worktree-epic/epic-the-wall-ii/dep-alpha' }],
    })
    expect(prompt).toContain('do not touch the wire protocol')
    expect(prompt.indexOf('CONSTRAINTS FROM THE WERK-MASTER')).toBeLessThan(prompt.indexOf('DEPENDS ON WORK'))
  })
})
