/**
 * THE STATS TABLE's claim, under test.
 *
 * `wall-vitals-history-store` Done #8 promised that a THIRD producer would be "a
 * metric string in `shared/stats.ts` plus one `recordStat()` call" -- no ALTER
 * TABLE, no migration, no new index, no change to the store. That is a claim
 * about COST, and a claim about cost that nothing measures quietly stops being
 * true the first time someone widens the table to fit a new stat.
 *
 * So this file measures it. If a fourth producer ever needs a schema change to
 * land, one of these assertions fails and the narrow-table design is what is
 * wrong -- not the assertion.
 *
 * WHY READ SOURCE RATHER THAN BEHAVIOUR. Behaviour is `token-stats.test.ts`'s
 * job and it is fully covered there. Cost is not observable at runtime: a
 * producer that worked perfectly while having forced a new column would pass
 * every behavioural test ever written.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dir

/**
 * A file's CODE lines -- comments and blanks dropped, trimmed.
 *
 * Every assertion below runs against this rather than the raw text, because
 * every file here EXPLAINS the design in prose: `schema.ts`'s docblock says the
 * words "ALTER TABLE" precisely to say it never does one, and asserting on raw
 * text would read that promise as its own violation.
 *
 * Assumes this repo's block-comment style (continuation lines start with `*`),
 * which the files it reads all follow.
 */
function codeLines(path: string): string[] {
  return readFileSync(join(HERE, path), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
}

const code = (path: string) => codeLines(path).join('\n')

const seam = codeLines('../add-transcript-entries.ts')
const producer = codeLines('./token-stats.ts')
const statsSchema = code('../../stats/schema.ts')
const statsStore = code('../../stats/store.ts')

const METRICS = ['tokens_in_count', 'tokens_out_count', 'cache_read_count', 'cache_write_count']

describe('the cost of the third producer', () => {
  // The headline number. One import, one call -- the entire edit to a 388-line
  // file that five other transcript handlers also route through.
  test('the seam file mentions the producer on exactly TWO lines', () => {
    const touched = seam.filter(l => l.includes('recordConversationTokenStats'))
    expect(touched).toHaveLength(2)
    expect(touched.filter(l => l.startsWith('import'))).toHaveLength(1)
  })

  test('the producer itself is four recordStat() calls and nothing else', () => {
    expect(producer.join('\n').match(/recordStat\(/g)).toHaveLength(4)
    // No second write path: it does not open, prepare, insert or migrate.
    expect(producer.join('\n')).not.toMatch(/bun:sqlite|CREATE TABLE|ALTER TABLE|prepare\(|db\./)
  })

  // 22 at the time of writing: three imports, a four-line ref, the four calls,
  // and the signature. The bound is what "a handful of lines" is worth arguing
  // about -- a producer that needed fifty would mean the vocabulary was wrong.
  test('the whole producer module is under 25 lines of code', () => {
    expect(producer.length).toBeLessThan(25)
  })
})

describe('the schema did not move', () => {
  // The narrow table's entire promise: a new stat is a new STRING. If any of the
  // four metric names had to be named in the DDL, the table is not narrow.
  test('no metric name and no object kind appears anywhere in the DDL', () => {
    for (const name of METRICS) expect(statsSchema).not.toContain(name)
    expect(statsSchema).not.toContain('conversation')
  })

  test('the DDL is still two tables and one index -- nothing was added for this', () => {
    expect(statsSchema.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2)
    expect(statsSchema.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(1)
    expect(statsSchema).not.toContain('ALTER TABLE')
  })

  // No conditional in the write path either: `recordStat` cannot know which
  // metric it is holding, which is what keeps producer #4 free as well.
  test('the store has no per-metric branch', () => {
    for (const name of METRICS) expect(statsStore).not.toContain(name)
  })
})
