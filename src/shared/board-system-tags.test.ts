import { describe, expect, test } from 'bun:test'
import { findSystemTag, SYSTEM_TAGS } from './board-system-tags'
import { NEEDS_WERK_MASTER_TAG } from './epic-run-types'

/**
 * THE REGISTRY IS A LIST OF WORDS, and the only things worth pinning about it
 * are the two that break silently: a duplicate (a picker offering the same tag
 * twice) and a spelling a card cannot carry.
 */
describe('SYSTEM_TAGS', () => {
  test('every entry is a distinct lowercase-kebab word', () => {
    const tags = SYSTEM_TAGS.map(t => t.tag)
    expect(new Set(tags).size).toBe(tags.length)
    for (const tag of tags) expect(tag).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  test('every entry says what reads it', () => {
    for (const entry of SYSTEM_TAGS) expect(entry.detail.length).toBeGreaterThan(0)
  })

  /**
   * THE BLOCKED CHANNEL'S TAG, BY ITS CONSTANT rather than by its spelling.
   * `epic-ready.ts` folds over the constant and this list is what a picker
   * offers; the two drifting apart is a question card nobody can file.
   */
  test('the blocked-question tag is the one the epic engine actually folds over', () => {
    expect(SYSTEM_TAGS.map(t => t.tag)).toContain(NEEDS_WERK_MASTER_TAG)
    expect(NEEDS_WERK_MASTER_TAG).toBe('needs-werk-master')
  })

  /**
   * DECLARED, INERT, AND THAT IS THE WHOLE POINT -- see the file header. These
   * two are named here before their consumers exist so three concurrent cards
   * do not each append one line to this array and conflict three ways.
   * `werk-verify-by-tag` and `werk-retrospect-hook` bring the behaviour; when
   * they land, this test keeps saying the words are spelled the same in both
   * places.
   */
  test('the two carded tags are declared ahead of their scanners', () => {
    const tags = SYSTEM_TAGS.map(t => t.tag)
    expect(tags).toContain('needs-verification')
    expect(tags).toContain('needs-retrospect')
  })
})

/**
 * The one-tag lookup, for a surface that offers a single system tag (the card
 * menu's one-click `ready`) and wants the registry's help text rather than a
 * second one written fresh.
 */
describe('findSystemTag', () => {
  test('hands back the row a surface would render, for every registered tag', () => {
    for (const entry of SYSTEM_TAGS) expect(findSystemTag(entry.tag)).toEqual(entry)
  })

  /** A REGISTRY, not an enforcement point: an unlisted tag is a legal thing for
   *  a card to carry, so asking about one is a miss and not an error. */
  test('an unregistered tag is a miss, not a throw', () => {
    expect(findSystemTag('some-label-someone-invented')).toBeUndefined()
  })
})
