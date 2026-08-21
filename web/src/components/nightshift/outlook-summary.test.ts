/**
 * The summary sentence and the bucket grouping -- the counting the pane leans on
 * to be honest about what will NOT run.
 */

import type { NightshiftOutlook, NightshiftOutlookRefusal } from '@shared/protocol'
import { describe, expect, test } from 'vitest'
import { bucketLabel, groupRefusals, summarize } from './outlook-summary'

const BUCKETS = ['closed-lane', 'live-conversation', 'unreadable', 'over-cap']

function refusal(unit: string, bucket: string): NightshiftOutlookRefusal {
  return { unit, bucket, detail: `${unit} was refused` }
}

function outlook(over: Partial<NightshiftOutlook> = {}): NightshiftOutlook {
  return { admitted: [], refused: [], selected: [], buckets: BUCKETS, totalTasks: 8, ...over }
}

describe('summarize', () => {
  test('nothing selected -> no sentence (the empty state says it better)', () => {
    expect(summarize(outlook())).toBeNull()
  })

  test('names every refusal bucket with a count, not just the survivors', () => {
    const line = summarize(
      outlook({
        admitted: [{ id: '001' }, { id: '002' }, { id: '003' }] as NightshiftOutlook['admitted'],
        refused: [refusal('d', 'live-conversation'), refusal('e', 'over-cap')],
        selected: ['a', 'b', 'c', 'd', 'e'],
      }),
    )
    expect(line).toBe('3 of 5 tagged, 1 held by a live conversation, 1 over the cap')
  })

  test('all refused -> the sentence still accounts for every selected card', () => {
    const line = summarize(outlook({ refused: [refusal('a', 'closed-lane')], selected: ['a'] }))
    expect(line).toBe('0 of 1 tagged, 1 in a closed lane')
  })
})

describe('groupRefusals', () => {
  test("groups in the scanner's declared order and drops empty buckets", () => {
    const groups = groupRefusals(
      outlook({ refused: [refusal('a', 'over-cap'), refusal('b', 'closed-lane')], selected: ['a', 'b'] }),
    )
    expect(groups.map(g => g.bucket)).toEqual(['closed-lane', 'over-cap'])
    expect(groups[1].items.map(i => i.unit)).toEqual(['a'])
  })

  test('a bucket the scanner adds later is rendered, not dropped', () => {
    const groups = groupRefusals(outlook({ refused: [refusal('a', 'brand-new')], selected: ['a'] }))
    expect(groups.map(g => g.bucket)).toEqual(['brand-new'])
    expect(groups[0].label).toBe('brand-new')
  })
})

describe('bucketLabel', () => {
  test('every declared bucket has human phrasing', () => {
    expect(BUCKETS.map(bucketLabel)).toEqual([
      'in a closed lane',
      'held by a live conversation',
      'unreadable at dispatch time',
      'over the cap',
    ])
  })
})
