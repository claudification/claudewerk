#!/usr/bin/env bun
/**
 * pick-node-env-tests.ts - find the test files that provably do not need jsdom.
 *
 * Building a jsdom costs this suite 476 CPU-seconds across 331 files, against
 * 61s actually running the tests. Roughly half the suite is pure logic that
 * never touches the DOM, and every one of those files is paying for a document
 * it never reads.
 *
 * "Didn't fail under environment:node" is NOT sufficient evidence to move a
 * file: a test can pass vacuously (a `describe` that never ran, a suite skipped
 * because an import threw, an assertion on a value that is undefined in both
 * worlds). So a file only qualifies when its per-test results are IDENTICAL
 * under both environments -- same test names, same order, same count, all
 * passing. Anything that differs in any way keeps jsdom.
 *
 *   bun scripts/pick-node-env-tests.ts <jsdom.json> <node.json>
 *
 * Prints one qualifying path per line; --apply prepends the docblock.
 */

import { readFileSync, writeFileSync } from 'node:fs'

type VitestAssertion = { fullName?: string; title?: string; status: string }
type VitestFile = { name: string; assertionResults?: VitestAssertion[] }
type VitestJson = { testResults?: VitestFile[] }

const DOCBLOCK = `/**\n * @vitest-environment node\n */\n`

/**
 * NUL, which no test name can contain. Built from its code point rather than
 * written as a literal so the source stays plain ASCII -- a raw control byte
 * pasted into the file makes grep treat the whole thing as binary.
 */
const SEP = String.fromCharCode(0)

function byFile(path: string): Map<string, VitestAssertion[]> {
  const json = JSON.parse(readFileSync(path, 'utf8')) as VitestJson
  const map = new Map<string, VitestAssertion[]>()
  for (const f of json.testResults ?? []) map.set(f.name, f.assertionResults ?? [])
  return map
}

const allPassed = (list: VitestAssertion[]) => list.every(t => t.status === 'passed')

/**
 * Test names in run order as one comparable string. The count is prefixed and
 * NUL separates, so equality here means equality of the whole list: a space
 * separator would let ["a b"] and ["a", "b"] compare equal, which is exactly
 * the near-miss this comparison exists to catch. The count prefix also subsumes
 * the length check.
 */
const nameSequence = (list: VitestAssertion[]) =>
  `${list.length}${SEP}${list.map(t => t.fullName ?? t.title).join(SEP)}`

/** Same tests, same order, same names, every one passing. */
function identicalAndGreen(a: VitestAssertion[], b: VitestAssertion[]): boolean {
  if (a.length === 0) return false
  return nameSequence(a) === nameSequence(b) && allPassed(a) && allPassed(b)
}

const [jsdomPath, nodePath, ...flags] = process.argv.slice(2)
if (!jsdomPath || !nodePath) {
  console.error('usage: pick-node-env-tests.ts <jsdom.json> <node.json> [--apply]')
  process.exit(1)
}

const jsdom = byFile(jsdomPath)
const node = byFile(nodePath)

const qualifying: string[] = []
for (const [file, jsdomTests] of jsdom) {
  const nodeTests = node.get(file)
  if (nodeTests && identicalAndGreen(jsdomTests, nodeTests)) qualifying.push(file)
}

qualifying.sort()

if (flags.includes('--apply')) {
  let applied = 0
  for (const file of qualifying) {
    const src = readFileSync(file, 'utf8')
    if (src.includes('@vitest-environment')) continue
    writeFileSync(file, DOCBLOCK + src)
    applied++
  }
  console.error(`applied @vitest-environment node to ${applied} files`)
} else {
  for (const f of qualifying) console.log(f)
}

console.error(
  `${qualifying.length} of ${jsdom.size} files qualify (identical results under both environments)`,
)
