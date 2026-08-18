/**
 * resolveForkCwds -- which directory a fork READS from and which it WRITES to.
 *
 * The two are independent and were conflated: a conversation born in a worktree
 * writes its transcript under the WORKTREE's slug, but a fork launched without
 * an explicit target lands in the PROJECT ROOT. Resolving one from the other in
 * either direction loses a fork.
 */
import { describe, expect, test } from 'bun:test'
import { resolveForkCwds } from './fork-cwds'

const PROJECT = '/Users/jonas/projects/anvil-md'
const WORKTREE = `${PROJECT}/.claude/worktrees/feat/anvil-highlighter`

describe('resolveForkCwds', () => {
  // Regression: fork built the source path from the project URI alone, so every
  // conversation born in a worktree resolved to the MAIN repo's slug and came
  // back "Source transcript not found" (188 of 2417 conversations).
  test('reads from the worktree the source session actually ran in', () => {
    const r = resolveForkCwds({ projectCwd: PROJECT, sourceWorktree: 'feat/anvil-highlighter' })
    expect(r.cwd).toBe(WORKTREE)
  })

  test('reads from the project root when the source was never in a worktree', () => {
    expect(resolveForkCwds({ projectCwd: PROJECT }).cwd).toBe(PROJECT)
  })

  // The other half of the same bug. Once the source resolves to the worktree,
  // "fork in place" must NOT mean "beside the source": a spawn with no target
  // launches in the project root, and a fork written under the worktree slug is
  // invisible to that `--resume` -- which reads as "the fork lost all context".
  test('a worktree-born source with no target writes to the PROJECT ROOT', () => {
    const r = resolveForkCwds({ projectCwd: PROJECT, sourceWorktree: 'feat/anvil-highlighter' })
    expect(r.targetCwd).toBe(PROJECT)
  })

  test('no worktree either side stays in place -- undefined, not a redundant copy', () => {
    expect(resolveForkCwds({ projectCwd: PROJECT }).targetCwd).toBeUndefined()
  })

  test('an explicit target worktree wins over the source worktree', () => {
    const r = resolveForkCwds({
      projectCwd: PROJECT,
      sourceWorktree: 'feat/anvil-highlighter',
      targetWorktree: 'feat/next',
    })
    expect(r.cwd).toBe(WORKTREE)
    expect(r.targetCwd).toBe(`${PROJECT}/.claude/worktrees/feat/next`)
  })

  test('targetWorktree beats targetCwd when both are set', () => {
    const r = resolveForkCwds({
      projectCwd: PROJECT,
      targetWorktree: 'feat/next',
      targetCwd: '/somewhere/else',
    })
    expect(r.targetCwd).toBe(`${PROJECT}/.claude/worktrees/feat/next`)
  })

  test('an explicit targetCwd retargets a worktree-born fork', () => {
    const r = resolveForkCwds({
      projectCwd: PROJECT,
      sourceWorktree: 'feat/anvil-highlighter',
      targetCwd: '/Users/jonas/projects/anvil-md',
    })
    expect(r.cwd).toBe(WORKTREE)
    expect(r.targetCwd).toBe(PROJECT)
  })

  // Forking back into the very worktree the source ran in is a no-op move, and
  // passing it on would make the sentinel mkdir a path it already reads from.
  test('retargeting onto the source itself collapses to in-place', () => {
    const r = resolveForkCwds({
      projectCwd: PROJECT,
      sourceWorktree: 'feat/anvil-highlighter',
      targetWorktree: 'feat/anvil-highlighter',
    })
    expect(r.cwd).toBe(WORKTREE)
    expect(r.targetCwd).toBeUndefined()
  })

  // The source worktree is routinely GONE by fork time (worktree-remove.sh runs
  // at merge), while its transcript lives on under the config dir. Resolution
  // is pure string work precisely so a missing directory still forks.
  test('resolves through a realpath hook without requiring the path to exist', () => {
    const r = resolveForkCwds({ projectCwd: PROJECT, sourceWorktree: 'gone' }, p => p.replace('/Users', '/private'))
    expect(r.cwd).toBe('/private/jonas/projects/anvil-md/.claude/worktrees/gone')
    expect(r.targetCwd).toBe('/private/jonas/projects/anvil-md')
  })
})
