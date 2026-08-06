import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NdjsonZstdWriter, readNdjsonZstd } from '../ndjson'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ndjson-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function roundTrip(rows: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const path = join(dir, 'rows.ndjson.zst')
  const writer = new NdjsonZstdWriter(path, 3)
  for (const r of rows) await writer.writeRow(r)
  await writer.close()

  const back: Array<Record<string, unknown>> = []
  await readNdjsonZstd(path, r => {
    back.push(r)
  })
  return back
}

test('round-trips a small batch verbatim', async () => {
  const rows = [
    { id: 1, content: 'plain' },
    { id: 2, content: 'with "quotes", commas\nand newlines' },
    { id: 3, content: null, extra: 0 },
  ]
  expect(await roundTrip(rows)).toEqual(rows)
})

// REGRESSION -- the reader used buf.toString('utf-8') per chunk. Real transcript
// text is full of multi-byte characters, and any that straddled a chunk boundary
// came back as U+FFFD. The file stayed byte-perfect so the sha256 still matched;
// the damage only surfaced when decoded rows were compared to the database --
// the exact check that gates deleting those rows. Found on production data, not
// by the synthetic fixture, which was pure ASCII.
test('multi-byte characters survive chunk boundaries', async () => {
  // Well past the writer's 4 MiB batch so boundaries fall mid-character in
  // many places, with a mix of 2-, 3- and 4-byte sequences.
  const multibyte = 'åéîøü ☃★♻ 🎉🙈🚀 中文日本語한국어 '
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    content: multibyte.repeat(500) + `row-${i}`,
  }))

  const back = await roundTrip(rows)

  expect(back).toHaveLength(rows.length)
  expect(back).toEqual(rows)
  // Belt and braces: no replacement characters anywhere.
  for (const r of back) expect(String(r.content)).not.toContain('�')
})

test('reports the plaintext hash and byte count of what it read', async () => {
  const path = join(dir, 'rows.ndjson.zst')
  const writer = new NdjsonZstdWriter(path, 3)
  await writer.writeRow({ id: 1, content: 'ünïcøde ☃' })
  const written = await writer.close()

  const read = await readNdjsonZstd(path, () => {})
  expect(read.rows).toBe(1)
  expect(read.plaintextBytes).toBe(written.plaintextBytes)
  expect(read.plaintextSha256).toBe(written.plaintextSha256)
})

test('handles a final row with no trailing newline content left over', async () => {
  const rows = [
    { id: 1, content: 'a' },
    { id: 2, content: 'b' },
  ]
  const back = await roundTrip(rows)
  expect(back.map(r => r.id)).toEqual([1, 2])
})
