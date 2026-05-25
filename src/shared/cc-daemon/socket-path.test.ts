import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveControlSocket,
  resolveSockDir,
  resolveWorkerPtySock,
  rosterPath,
  sockDirFromRosterData,
} from './socket-path'

describe('rosterPath (CLAUDE_CONFIG_DIR audit fix, transport-reframe Phase 2)', () => {
  it('resolves roster.json under CLAUDE_CONFIG_DIR when set', () => {
    expect(rosterPath({ CLAUDE_CONFIG_DIR: '/profiles/work/.claude' })).toBe(
      '/profiles/work/.claude/daemon/roster.json',
    )
  })

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(rosterPath({})).toBe(join(homedir(), '.claude', 'daemon', 'roster.json'))
  })
})

describe('sockDirFromRosterData', () => {
  it('derives the sock dir two segments up from a worker rendezvous socket', () => {
    const dir = sockDirFromRosterData({
      workers: { aeb185f9: { rendezvousSock: '/tmp/cc-daemon-501/ab12cd34/rv/aeb185f9.sock' } },
    })
    expect(dir).toBe('/tmp/cc-daemon-501/ab12cd34')
  })

  it('returns null when the roster has no workers', () => {
    expect(sockDirFromRosterData({ workers: {} })).toBeNull()
    expect(sockDirFromRosterData({})).toBeNull()
  })

  it('skips workers that carry no rendezvousSock', () => {
    const dir = sockDirFromRosterData({
      workers: {
        a: undefined,
        b: {},
        c: { rendezvousSock: '/tmp/cc-daemon-501/ffffeeee/rv/c.sock' },
      },
    })
    expect(dir).toBe('/tmp/cc-daemon-501/ffffeeee')
  })
})

describe('resolveControlSocket / resolveSockDir', () => {
  // The daemon is transient: depending on the host it may or may not be up.
  // Both contracts hold either way -- a path or a clean null, never a throw.
  it('resolves to a control.sock path or null, without throwing', () => {
    const sock = resolveControlSocket()
    expect(sock === null || sock.endsWith('control.sock')).toBe(true)
  })

  it('resolves a sock dir or null, without throwing', () => {
    const dir = resolveSockDir()
    expect(dir === null || typeof dir === 'string').toBe(true)
  })
})

describe('per-profile routing (multi-daemon disambiguation)', () => {
  // Each test profile gets its own fake CLAUDE_CONFIG_DIR with its own
  // daemon/roster.json. Verifies the env arg actually selects which
  // roster is read -- the bug was that resolveControlSocket() always
  // consulted a module-level ROSTER_PATH frozen at import time.
  let work: string
  let alt: string
  let workSockDir: string
  let altSockDir: string

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'cw-profile-work-'))
    alt = mkdtempSync(join(tmpdir(), 'cw-profile-alt-'))
    workSockDir = '/tmp/cc-daemon-test/work-instance-aaaa'
    altSockDir = '/tmp/cc-daemon-test/alt-instance-bbbb'
    mkdirSync(join(work, 'daemon'), { recursive: true })
    mkdirSync(join(alt, 'daemon'), { recursive: true })
    writeFileSync(
      join(work, 'daemon', 'roster.json'),
      JSON.stringify({
        proto: 1,
        supervisorPid: 1001,
        workers: {
          aaaaaaaa: {
            rendezvousSock: `${workSockDir}/rv/aaaaaaaa.sock`,
            ptySock: `${workSockDir}/spare/w.pty.sock`,
          },
        },
      }),
    )
    writeFileSync(
      join(alt, 'daemon', 'roster.json'),
      JSON.stringify({
        proto: 1,
        supervisorPid: 2002,
        workers: {
          bbbbbbbb: {
            rendezvousSock: `${altSockDir}/rv/bbbbbbbb.sock`,
            ptySock: `${altSockDir}/spare/a.pty.sock`,
          },
        },
      }),
    )
  })

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
    rmSync(alt, { recursive: true, force: true })
  })

  it('resolveSockDir routes to the work-profile sock dir when CLAUDE_CONFIG_DIR=work', () => {
    expect(resolveSockDir({ CLAUDE_CONFIG_DIR: work })).toBe(workSockDir)
  })

  it('resolveSockDir routes to the alt-profile sock dir when CLAUDE_CONFIG_DIR=alt', () => {
    expect(resolveSockDir({ CLAUDE_CONFIG_DIR: alt })).toBe(altSockDir)
  })

  it('explicit env disables scan fallback -- empty roster returns null instead of guessing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cw-profile-empty-'))
    mkdirSync(join(empty, 'daemon'), { recursive: true })
    writeFileSync(join(empty, 'daemon', 'roster.json'), JSON.stringify({ proto: 1, supervisorPid: 3003, workers: {} }))
    try {
      // Even if the per-uid /tmp tree has socks from other profiles, strict mode
      // must NOT scan -- the resolver can't tell which one belongs to `empty`.
      expect(resolveSockDir({ CLAUDE_CONFIG_DIR: empty })).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('missing roster file with explicit env returns null (no scan fallback)', () => {
    expect(resolveSockDir({ CLAUDE_CONFIG_DIR: '/nonexistent-profile-dir-xyz' })).toBeNull()
  })

  it('resolveWorkerPtySock honors the env arg when reading the profile roster', () => {
    expect(resolveWorkerPtySock('aaaaaaaa', { CLAUDE_CONFIG_DIR: work })).toBe(`${workSockDir}/spare/w.pty.sock`)
    expect(resolveWorkerPtySock('bbbbbbbb', { CLAUDE_CONFIG_DIR: alt })).toBe(`${altSockDir}/spare/a.pty.sock`)
    // Cross-profile lookup: alt's worker short does not exist in work's roster.
    expect(resolveWorkerPtySock('bbbbbbbb', { CLAUDE_CONFIG_DIR: work })).toBeNull()
  })
})
