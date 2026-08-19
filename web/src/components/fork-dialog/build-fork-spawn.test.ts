/**
 * @vitest-environment node
 */
/**
 * The fork SpawnRequest shape.
 *
 * A fork that launches on the wrong profile boots fine and inherits nothing --
 * there is no error to notice, so the guard has to live in a test.
 */

import { describe, expect, test } from 'vitest'
import type { Conversation } from '@/lib/types'
import { buildForkSpawnRequest } from './build-fork-spawn'

const SOURCE = {
  id: 'conv_parent',
  project: 'claude://default/Users/jonas/projects/repo',
  resolvedProfile: 'work',
} as Conversation

describe('buildForkSpawnRequest', () => {
  test('pins a resumed fork to the source profile', () => {
    const req = buildForkSpawnRequest(SOURCE, { resumeId: 'cc-fork-1' }, {})
    expect(req.mode).toBe('resume')
    expect(req.resumeId).toBe('cc-fork-1')
    expect(req.profile).toBe('work')
  })

  // An unset resolvedProfile means the source ran on the implicit default --
  // and `default` is a literal pin to the picker, not "you choose".
  test('pins to the literal default profile when the source has none', () => {
    const req = buildForkSpawnRequest({ ...SOURCE, resolvedProfile: undefined }, { resumeId: 'cc-fork-1' }, {})
    expect(req.profile).toBe('default')
  })

  // A summary fork resumes nothing, so no profile holds its transcript.
  test('leaves a summary fork unpinned', () => {
    const req = buildForkSpawnRequest(SOURCE, { seedPrompt: 'GOAL -- ship it' }, {})
    expect(req.profile).toBeUndefined()
    expect(req.mode).toBeUndefined()
    expect(req.appendSystemPrompt).toBe('GOAL -- ship it')
  })

  test('carries the transport choice through to the spawn', () => {
    expect(buildForkSpawnRequest(SOURCE, { resumeId: 'x' }, { headless: false }).headless).toBe(false)
    expect(buildForkSpawnRequest(SOURCE, { resumeId: 'x' }, { headless: true }).headless).toBe(true)
    expect(buildForkSpawnRequest(SOURCE, { resumeId: 'x' }, {}).headless).toBeUndefined()
  })

  test('defaults cwd to the source project and trims overrides', () => {
    expect(buildForkSpawnRequest(SOURCE, { resumeId: 'x' }, {}).cwd).toBe('/Users/jonas/projects/repo')
    const req = buildForkSpawnRequest(SOURCE, { resumeId: 'x' }, { cwd: '  /elsewhere  ', name: '  Fork  ' })
    expect(req.cwd).toBe('/elsewhere')
    expect(req.name).toBe('Fork')
  })

  test('drops blank overrides rather than sending empty strings', () => {
    const req = buildForkSpawnRequest(SOURCE, { resumeId: 'x' }, { name: '   ', model: '', effort: '', worktree: ' ' })
    expect(req.name).toBeUndefined()
    expect(req.model).toBeUndefined()
    expect(req.effort).toBeUndefined()
    expect(req.worktree).toBeUndefined()
  })
})
