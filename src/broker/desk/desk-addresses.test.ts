import { describe, expect, it } from 'bun:test'
import type { ConversationLike } from '../conversation-address'
import { addressesMatching, addressFleet } from './desk-addresses'

const RC = 'claude://default/Users/jonas/projects/remote-claude'
const ARR = 'claude://default/Users/jonas/projects/arr'

const conv = (id: string, project: string, title?: string): ConversationLike => ({ id, project, title })

describe('addressFleet', () => {
  it('addresses each conversation as project:conversation', () => {
    const map = addressFleet([conv('c1', RC, 'nightshift'), conv('c2', ARR, 'Movie Sync')])
    expect(map.get('c1')).toBe('remote-claude:nightshift')
    expect(map.get('c2')).toBe('arr:movie-sync')
  })

  it('disambiguates same-titled siblings within a project', () => {
    const map = addressFleet([conv('c1', RC, 'fix'), conv('c2', RC, 'fix')])
    expect(map.get('c1')).toBe('remote-claude:fix-c1')
    expect(map.get('c2')).toBe('remote-claude:fix-c2')
  })

  it('does NOT disambiguate a same title in a DIFFERENT project', () => {
    const map = addressFleet([conv('c1', RC, 'fix'), conv('c2', ARR, 'fix')])
    expect(map.get('c1')).toBe('remote-claude:fix')
    expect(map.get('c2')).toBe('arr:fix')
  })

  it('falls back to an id slice for an untitled conversation', () => {
    expect(addressFleet([conv('abcdefghij', RC)]).get('abcdefghij')).toBe('remote-claude:abcdefgh')
  })

  it('skips a conversation with no project -- nothing to address it under', () => {
    const map = addressFleet([conv('c1', ''), conv('c2', RC, 'ok')])
    expect(map.has('c1')).toBe(false)
    expect(map.get('c2')).toBe('remote-claude:ok')
  })

  it('produces addresses the pattern matcher can actually match', () => {
    // The whole contract between this file and conversation-address.ts: a
    // project dir with dots/underscores must still land inside the pattern
    // charset, or a watch on it could never be expressed.
    const map = addressFleet([conv('c1', 'claude://default/srv/my_site.com', 'deploy')])
    expect(map.get('c1')).toBe('my-site-com:deploy')
    expect(addressesMatching([conv('c1', 'claude://default/srv/my_site.com', 'deploy')], ['my-site-com:*'])).toEqual([
      'my-site-com:deploy',
    ])
  })
})

describe('addressesMatching', () => {
  const fleet = [conv('c1', RC, 'nightshift'), conv('c2', RC, 'fix-login'), conv('c3', ARR, 'fix-sync')]

  it('reports what a project pattern catches right now', () => {
    expect(addressesMatching(fleet, ['remote-claude:*'])).toEqual([
      'remote-claude:fix-login',
      'remote-claude:nightshift',
    ])
  })

  it('reports what a cross-project glob catches', () => {
    expect(addressesMatching(fleet, ['*:fix-*'])).toEqual(['arr:fix-sync', 'remote-claude:fix-login'])
  })

  it('returns nothing for a pattern that matches nothing -- the typo signal', () => {
    expect(addressesMatching(fleet, ['remote-clod:*'])).toEqual([])
    expect(addressesMatching(fleet, [])).toEqual([])
  })
})
