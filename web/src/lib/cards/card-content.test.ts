/**
 * What counts as a card, and what the preview gets to show.
 *
 * The decision matters because the caller has a fallback: say "not a card" and
 * the tool line dumps source instead. So a card with a lane we have never heard
 * of must still render (the file is clearly a card), while a plain markdown file
 * that happens to live under `cards/` must not pretend to be one.
 */

import { describe, expect, test } from 'vitest'
import { parseCardContent } from './card-content'

const CARD = `---
title: Wall time cursor
status: in-progress
priority: high
tags: [wall, ui]
epic: wall-epic
created: 2026-08-19T10:00:00Z
---

Scrub the wall back through time.
`

describe('parseCardContent', () => {
  test('reads the frontmatter a card carries', () => {
    const card = parseCardContent(CARD)
    expect(card).toMatchObject({
      title: 'Wall time cursor',
      status: 'in-progress',
      state: 'active',
      priority: 'high',
      epic: 'wall-epic',
      tags: ['wall', 'ui'],
    })
    expect(card?.body).toBe('Scrub the wall back through time.')
  })

  test('is not a card without a title or a known status', () => {
    expect(parseCardContent('# Just a document\n\nno frontmatter here')).toBeNull()
    expect(parseCardContent('---\nfoo: bar\n---\n\nbody')).toBeNull()
  })

  test('an unknown lane still renders -- as a card in no known state', () => {
    const card = parseCardContent('---\ntitle: Half-migrated\nstatus: backlog\n---\n\nbody')
    expect(card?.status).toBeNull()
    expect(card?.state).toBe('unknown')
    expect(card?.title).toBe('Half-migrated')
  })

  test('a title-less card in a known lane keeps its lane', () => {
    const card = parseCardContent('---\nstatus: done\n---\n\nbody')
    expect(card?.state).toBe('done')
    expect(card?.title).toBe('')
    expect(card?.tags).toEqual([])
  })
})
