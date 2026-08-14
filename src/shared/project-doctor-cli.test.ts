import { describe, expect, test } from 'bun:test'
import { type DoctorArgs, formatDoctorReport, parseDoctorArgs, runDoctor } from './project-doctor-cli'
import type { RepairMode } from './project-doctor-created'
import type { DoctorFinding, DoctorReport } from './project-doctor-types'

const finding = (over: Partial<DoctorFinding> = {}): DoctorFinding => ({
  check: 'view-missing',
  severity: 'info',
  subject: 'a-card',
  problem: 'no view link',
  remedy: 'run board:upgrade',
  ...over,
})

const report = (findings: DoctorFinding[], over: Partial<DoctorReport> = {}): DoctorReport => ({
  board: '/p/.rclaude/project',
  noBoard: false,
  cards: findings.length,
  findings,
  ...over,
})

const opts = (over: Partial<{ quiet: boolean; strict: boolean; verbose: boolean }> = {}) => ({
  quiet: false,
  strict: false,
  verbose: false,
  ...over,
})

describe('parseDoctorArgs', () => {
  test('defaults to the cwd, everything off', () => {
    const parsed = parseDoctorArgs([], '/here')
    expect(parsed).toEqual({
      kind: 'run',
      args: { root: '/here', all: false, dryRun: false, quiet: false, verbose: false, strict: false },
    })
  })

  test('--root, --all, and the short flags', () => {
    expect(parseDoctorArgs(['--root', '/x'], '/here')).toMatchObject({ args: { root: '/x', all: false } })
    expect(parseDoctorArgs(['--all', '/projects'], '/here')).toMatchObject({ args: { root: '/projects', all: true } })
    expect(parseDoctorArgs(['-q', '-v', '--strict'], '/here')).toMatchObject({
      args: { quiet: true, verbose: true, strict: true },
    })
  })

  test('--dry-run and -n both preview', () => {
    expect(parseDoctorArgs(['--dry-run'], '/here')).toMatchObject({ args: { dryRun: true } })
    expect(parseDoctorArgs(['-n'], '/here')).toMatchObject({ args: { dryRun: true } })
  })

  test('help and unknown arguments', () => {
    expect(parseDoctorArgs(['--help'], '/here').kind).toBe('help')
    expect(parseDoctorArgs(['-h'], '/here').kind).toBe('help')
    const bad = parseDoctorArgs(['--nope'], '/here')
    expect(bad.kind).toBe('error')
    expect(bad.kind === 'error' && bad.message).toContain('--nope')
  })
})

describe('formatDoctorReport', () => {
  test('no board is not a failure', () => {
    const out = formatDoctorReport(report([], { noBoard: true }), opts())
    expect(out.exitCode).toBe(0)
    expect(out.out.join('\n')).toContain('nothing to check')
  })

  test('a clean board says so', () => {
    const out = formatDoctorReport(report([]), opts())
    expect(out.out.join('\n')).toContain('clean bill of health')
    expect(out.exitCode).toBe(0)
  })

  test('every finding prints its problem AND its remedy', () => {
    const text = formatDoctorReport(report([finding({ severity: 'error' })]), opts()).out.join('\n')
    expect(text).toContain('no view link')
    expect(text).toContain('-> run board:upgrade')
  })

  test('an error exits 1; a warning alone does not, unless --strict', () => {
    expect(formatDoctorReport(report([finding({ severity: 'error' })]), opts()).exitCode).toBe(1)
    expect(formatDoctorReport(report([finding({ severity: 'warning' })]), opts()).exitCode).toBe(0)
    expect(formatDoctorReport(report([finding({ severity: 'warning' })]), opts({ strict: true })).exitCode).toBe(1)
    expect(formatDoctorReport(report([finding({ severity: 'info' })]), opts({ strict: true })).exitCode).toBe(0)
  })

  test('--quiet drops info findings but still counts them in the header', () => {
    const out = formatDoctorReport(
      report([finding({ severity: 'info' }), finding({ severity: 'warning' })]),
      opts({ quiet: true }),
    )
    const text = out.out.join('\n')
    expect(text).toContain('info: 1')
    expect(text).toContain('WARN')
    expect(text).not.toContain('INFO')
  })

  test('a big group of one check collapses into a single entry', () => {
    const many = Array.from({ length: 43 }, (_, i) => finding({ subject: `card-${i}` }))
    const text = formatDoctorReport(report(many), opts()).out.join('\n')
    expect(text).toContain('43 findings')
    expect(text).toContain('+40 more')
    expect(text).not.toContain('card-42')
  })

  test('--verbose lists every one of them instead', () => {
    const many = Array.from({ length: 43 }, (_, i) => finding({ subject: `card-${i}` }))
    const text = formatDoctorReport(report(many), opts({ verbose: true })).out.join('\n')
    expect(text).toContain('card-42')
    expect(text).not.toContain('43 findings')
  })

  test('a small group is never collapsed', () => {
    const few = Array.from({ length: 3 }, (_, i) => finding({ subject: `card-${i}` }))
    const text = formatDoctorReport(report(few), opts()).out.join('\n')
    expect(text).toContain('card-2')
    expect(text).not.toContain('3 findings')
  })
})

describe('runDoctor', () => {
  const cliArgs = (over: Partial<DoctorArgs> = {}): DoctorArgs => ({
    root: '/p',
    all: false,
    dryRun: false,
    quiet: false,
    verbose: false,
    strict: false,
    ...over,
  })

  test('one board', () => {
    const out = runDoctor(
      cliArgs(),
      () => report([]),
      () => [],
    )
    expect(out.exitCode).toBe(0)
    expect(out.out.join('\n')).toContain('clean bill of health')
  })

  test('--all sweeps every board, and the WORST exit code wins', () => {
    const roots = ['/a', '/b']
    const out = runDoctor(
      cliArgs({ root: '/parent', all: true }),
      root => report(root === '/b' ? [finding({ severity: 'error' })] : []),
      () => roots,
    )
    expect(out.out.join('\n')).toContain('checking 2 board(s)')
    expect(out.exitCode).toBe(1)
  })

  test('the CLI repairs by DEFAULT -- a human typing board:doctor wants it fixed', () => {
    const seen: RepairMode[] = []
    runDoctor(
      cliArgs(),
      (_root, repair) => {
        seen.push(repair)
        return report([])
      },
      () => [],
    )
    expect(seen).toEqual(['write'])
  })

  test('--dry-run downgrades every board in the sweep to preview', () => {
    const seen: RepairMode[] = []
    runDoctor(
      cliArgs({ root: '/parent', all: true, dryRun: true }),
      (_root, repair) => {
        seen.push(repair)
        return report([])
      },
      () => ['/a', '/b'],
    )
    expect(seen).toEqual(['preview', 'preview'])
  })
})
