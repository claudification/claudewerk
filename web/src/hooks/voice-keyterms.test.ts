/**
 * @vitest-environment node
 */
/**
 * The vocabulary merge. Keyterms are not cosmetic: on the same 26s fixture the
 * model returned "CloudFlo" bare and "Cloudflare" with them on, so what ends up
 * in this list is what the transcript gets right.
 */

import { expect, test } from 'vitest'
import { projectKeyterms, resolveKeyterms } from '@/hooks/voice-keyterms'

test('ships this app own vocabulary even with no project configured', () => {
  const terms = resolveKeyterms()

  // Per-project keyterms are opt-in and mostly empty; without built-ins nobody
  // would get the fix by default.
  expect(terms).toEqual(['Cloudflare', 'Claude', 'claudewerk', 'werk'])
})

test('stays tiny -- a long list measurably undoes the fix', () => {
  // 4 and 6 terms turned "CloudFlo" into "Cloudflare" on the probe fixture;
  // 10 and 25 put it straight back. 4 is the current size -- still in the
  // safe band. Growing further needs a probe run, so pin the size and make
  // the next person come and read why.
  expect(resolveKeyterms()).toHaveLength(4)
})

test('puts project terms FIRST, so the cap eats the generic ones', () => {
  const terms = resolveKeyterms(['yemaya', 'portal2'])

  expect(terms.slice(0, 2)).toEqual(['yemaya', 'portal2'])
})

test('de-duplicates case-insensitively rather than spending two slots', () => {
  const terms = resolveKeyterms(['cloudflare', 'CLOUDFLARE'])

  expect(terms.filter(t => t.toLowerCase() === 'cloudflare')).toEqual(['cloudflare'])
})

test('drops blank terms instead of sending an empty keyterm', () => {
  expect(resolveKeyterms(['  ', ''])).not.toContain('')
})

test('an unknown or missing project is the normal case, not an error', () => {
  expect(projectKeyterms(undefined, {})).toEqual([])
  expect(projectKeyterms('claude:///nope', {})).toEqual([])
})
