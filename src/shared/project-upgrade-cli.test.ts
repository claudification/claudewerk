import { describe, expect, test } from 'bun:test'
import type { UpgradeReport } from './project-upgrade'
import { formatUpgradeReport, parseUpgradeArgs, runUpgrade } from './project-upgrade-cli'

const CWD = '/tmp/proj'

function report(patch: Partial<UpgradeReport> = {}): UpgradeReport {
  return {
    board: '/tmp/proj/.rclaude/project',
    noBoard: false,
    legacy: [],
    collisions: [],
    backedUp: 0,
    moved: [],
    failures: [],
    lanesRemoved: [],
    ...patch,
  }
}
const legacyCard = (slug: string, status: UpgradeReport['legacy'][number]['status']) => ({
  slug,
  status,
  abs: `/tmp/proj/.rclaude/project/${status}/${slug}.md`,
  mtime: 0,
})

describe('parseUpgradeArgs', () => {
  test('defaults to cwd, single board, backup on', () => {
    expect(parseUpgradeArgs([], CWD)).toEqual({
      kind: 'run',
      args: { root: CWD, all: false, dryRun: false, backup: true },
    })
  })

  test('--all sets the parent dir and switches to sweep mode', () => {
    const r = parseUpgradeArgs(['--all', '/Users/jonas/projects'], CWD)
    expect(r.kind === 'run' && r.args).toMatchObject({ root: '/Users/jonas/projects', all: true })
  })

  test('--root takes the next argument', () => {
    const r = parseUpgradeArgs(['--root', '/elsewhere'], CWD)
    expect(r.kind === 'run' && r.args.root).toBe('/elsewhere')
  })

  test('a --root with no value falls back to cwd rather than eating undefined', () => {
    const r = parseUpgradeArgs(['--root'], CWD)
    expect(r.kind === 'run' && r.args.root).toBe(CWD)
  })

  test('flags, long and short', () => {
    const r = parseUpgradeArgs(['--dry-run', '--no-backup'], CWD)
    expect(r.kind === 'run' && r.args).toMatchObject({ dryRun: true, backup: false })
    expect(parseUpgradeArgs(['-n'], CWD)).toMatchObject({ args: { dryRun: true } })
  })

  test('help and unknown arguments are distinct outcomes', () => {
    expect(parseUpgradeArgs(['--help'], CWD).kind).toBe('help')
    expect(parseUpgradeArgs(['-h'], CWD).kind).toBe('help')
    const bad = parseUpgradeArgs(['--wat'], CWD)
    expect(bad.kind).toBe('error')
    expect(bad.kind === 'error' && bad.message).toContain('--wat')
  })
})

describe('formatUpgradeReport', () => {
  test('no board says so and exits 0', () => {
    const f = formatUpgradeReport(report({ noBoard: true }), false)
    expect(f.out.join('\n')).toContain('nothing to do')
    expect(f.exitCode).toBe(0)
  })

  test('an already-migrated board is reported as such', () => {
    const f = formatUpgradeReport(report({}), false)
    expect(f.out).toContain('already migrated')
    expect(f.exitCode).toBe(0)
  })

  test('a dry run lists the moves it would make and nothing else', () => {
    const f = formatUpgradeReport(report({ legacy: [legacyCard('a', 'open')] }), true)
    const text = f.out.join('\n')
    expect(text).toContain('--dry-run: would move')
    expect(text).toContain('open/a.md -> cards/a.md  (status: open)')
    expect(text).not.toContain('moved 1 card')
  })

  test('a real run reports backup, moves and emptied lanes', () => {
    const f = formatUpgradeReport(
      report({
        legacy: [legacyCard('a', 'open')],
        moved: ['a'],
        backupDir: '/tmp/proj/.rclaude/project/.upgrade-backup-x',
        backedUp: 1,
        lanesRemoved: ['open'],
      }),
      false,
    )
    const text = f.out.join('\n')
    expect(text).toContain('backed up 1 file(s)')
    expect(text).toContain('moved 1 card(s) into cards/')
    expect(text).toContain('removed empty lane dirs: open')
  })

  test('collisions are reported with the winner named', () => {
    const f = formatUpgradeReport(report({ collisions: [{ slug: 'clash', lanes: ['open', 'done'] }] }), false)
    expect(f.out.join('\n')).toContain('clash: open, done -> keeping "done"')
  })

  test('failures go to stderr and set a non-zero exit', () => {
    const f = formatUpgradeReport(
      report({ legacy: [legacyCard('a', 'open')], failures: [{ slug: 'a', from: 'open', error: 'boom' }] }),
      false,
    )
    expect(f.exitCode).toBe(1)
    expect(f.err.join('\n')).toContain('open/a.md: boom')
  })
})

describe('runUpgrade', () => {
  const args = { root: '/p', all: false, dryRun: false, backup: true }
  const ok = (board: string) => report({ board })
  const noFind = () => {
    throw new Error('should not look for sibling boards')
  }

  test('a single board runs exactly once and does not scan for siblings', () => {
    const seen: string[] = []
    const r = runUpgrade(
      args,
      root => {
        seen.push(root)
        return ok(root)
      },
      noFind,
    )
    expect(seen).toEqual(['/p'])
    expect(r.exitCode).toBe(0)
  })

  test('--all runs every board it finds and announces the count', () => {
    const seen: string[] = []
    const r = runUpgrade(
      { ...args, all: true },
      root => {
        seen.push(root)
        return ok(root)
      },
      () => ['/p/a', '/p/b', '/p/c'],
    )
    expect(seen).toEqual(['/p/a', '/p/b', '/p/c'])
    expect(r.out[0]).toBe('sweeping 3 board(s) under /p')
  })

  test('--all reports the WORST exit code, not the last one', () => {
    const r = runUpgrade(
      { ...args, all: true },
      root =>
        root === '/p/b'
          ? report({ board: root, legacy: [], failures: [{ slug: 'x', from: 'open', error: 'boom' }] })
          : ok(root),
      () => ['/p/a', '/p/b', '/p/c'],
    )
    expect(r.exitCode).toBe(1)
    expect(r.err.join('\n')).toContain('boom')
  })

  test('--all over an empty parent is a clean no-op', () => {
    const r = runUpgrade(
      { ...args, all: true },
      () => {
        throw new Error('nothing to run')
      },
      () => [],
    )
    expect(r.exitCode).toBe(0)
    expect(r.out[0]).toBe('sweeping 0 board(s) under /p')
  })

  test('the dry-run flag reaches the runner', () => {
    let sawDryRun: boolean | undefined
    runUpgrade(
      { ...args, dryRun: true },
      (root, opts) => {
        sawDryRun = opts.dryRun
        return ok(root)
      },
      noFind,
    )
    expect(sawDryRun).toBe(true)
  })
})
