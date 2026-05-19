/**
 * Tests for the `sentinel profile` CLI's pure pieces: list / add / rm / pool.
 * The `auth` subcommand shells out to `claude auth login`, which is not
 * exercised here -- the smoke script covers env propagation separately.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProfileCli } from './profile-cli'

let scratch = ''
let configPath = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'profile-cli-'))
  configPath = join(scratch, 'sentinel.json')
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('sentinel profile list', () => {
  test('handles missing file (prints implicit default)', async () => {
    const code = await runProfileCli(['list'], { configPath })
    expect(code).toBe(0)
  })

  test('reads an existing file', async () => {
    writeFileSync(configPath, JSON.stringify({ profiles: { work: { configDir: join(scratch, 'cd-work') } } }))
    const code = await runProfileCli(['list'], { configPath })
    expect(code).toBe(0)
  })
})

describe('sentinel profile add', () => {
  test('creates a profile in a fresh file', async () => {
    const code = await runProfileCli(
      ['add', 'work', '--config-dir', join(scratch, 'cd-work'), '--label', 'Work', '--no-pool'],
      { configPath },
    )
    expect(code).toBe(0)
    expect(existsSync(configPath)).toBe(true)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(written.profiles.work.configDir).toBe(join(scratch, 'cd-work'))
    expect(written.profiles.work.label).toBe('Work')
    expect(written.profiles.work.pooled).toBe(false)
  })

  test('rejects duplicate add', async () => {
    await runProfileCli(['add', 'work', '--config-dir', '/x'], { configPath })
    const code = await runProfileCli(['add', 'work', '--config-dir', '/y'], { configPath })
    expect(code).toBe(1)
  })

  test('rejects bad profile name', async () => {
    const code = await runProfileCli(['add', 'Bad Name', '--config-dir', '/x'], { configPath })
    expect(code).toBe(2)
  })

  test('rejects missing --config-dir', async () => {
    const code = await runProfileCli(['add', 'work'], { configPath })
    expect(code).toBe(2)
  })
})

describe('sentinel profile rm', () => {
  test('removes an existing profile', async () => {
    writeFileSync(configPath, JSON.stringify({ profiles: { work: { configDir: join(scratch, 'cd-work') } } }))
    const code = await runProfileCli(['rm', 'work'], { configPath })
    expect(code).toBe(0)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(written.profiles).toEqual({})
  })

  test('refuses to remove default', async () => {
    const code = await runProfileCli(['rm', 'default'], { configPath })
    expect(code).toBe(2)
  })

  test('reports unknown profile', async () => {
    writeFileSync(configPath, '{}')
    const code = await runProfileCli(['rm', 'no-such'], { configPath })
    expect(code).toBe(1)
  })
})

describe('sentinel profile pool', () => {
  test('toggles pooled off then on', async () => {
    writeFileSync(configPath, JSON.stringify({ profiles: { work: { configDir: join(scratch, 'cd-work') } } }))
    const off = await runProfileCli(['pool', 'work', '--off'], { configPath })
    expect(off).toBe(0)
    expect(JSON.parse(readFileSync(configPath, 'utf8')).profiles.work.pooled).toBe(false)
    const on = await runProfileCli(['pool', 'work', '--on'], { configPath })
    expect(on).toBe(0)
    expect(JSON.parse(readFileSync(configPath, 'utf8')).profiles.work.pooled).toBe(true)
  })

  test('rejects missing --on/--off', async () => {
    writeFileSync(configPath, JSON.stringify({ profiles: { work: { configDir: join(scratch, 'cd-work') } } }))
    const code = await runProfileCli(['pool', 'work'], { configPath })
    expect(code).toBe(2)
  })

  test('reports unknown profile', async () => {
    const code = await runProfileCli(['pool', 'no-such', '--on'], { configPath })
    expect(code).toBe(1)
  })
})

describe('sentinel profile -- unknown subcommand + help', () => {
  test('--help exits 0', async () => {
    expect(await runProfileCli(['--help'])).toBe(0)
    expect(await runProfileCli([])).toBe(0)
  })

  test('unknown subcommand exits 2', async () => {
    expect(await runProfileCli(['frob'], { configPath })).toBe(2)
  })
})
