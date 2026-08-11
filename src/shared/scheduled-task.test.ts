/**
 * Schedule schema tests -- the write-time gate.
 *
 * Everything here is a rule that, if it leaked through, would produce a schedule
 * that either never fires or fires at the wrong time with no error anywhere:
 * an unparseable cron, a bogus zone, a missing prompt, an inverted window.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SCHEDULE_SPAWN,
  newScheduledRunId,
  newScheduledTaskId,
  scheduledTaskCreateSchema,
  scheduledTaskPatchSchema,
  validatedScheduledTaskSchema,
} from './scheduled-task'

const BASE = {
  name: 'nightly audit',
  enabled: true,
  projectUri: 'claude:///Users/jonas/projects/remote-claude',
  cwd: '/Users/jonas/projects/remote-claude',
  cron: '0 9 * * 1-5',
  tz: 'Europe/Berlin',
  catchUp: 'skip' as const,
  overlap: 'skip' as const,
  prompt: 'Audit the repo.',
  spawn: DEFAULT_SCHEDULE_SPAWN,
}

const FULL = {
  ...BASE,
  id: newScheduledTaskId(),
  createdBy: 'jonas',
  createdAt: 1,
  updatedAt: 1,
  runCount: 0,
  consecutiveFailures: 0,
}

/** First error message, or '' when the parse unexpectedly succeeded. */
function errorOf(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } },
  value: unknown,
): string {
  const res = schema.safeParse(value)
  return res.success ? '' : (res.error?.issues[0]?.message ?? 'unknown')
}

describe('validatedScheduledTaskSchema', () => {
  test('accepts a well-formed schedule', () => {
    expect(validatedScheduledTaskSchema.safeParse(FULL).success).toBe(true)
  })

  test('rejects an unparseable cron, quoting the reason', () => {
    expect(errorOf(validatedScheduledTaskSchema, { ...FULL, cron: '99 * * * *' })).toContain('cron:')
  })

  test('rejects a bogus timezone -- the whole point of requiring one', () => {
    expect(errorOf(validatedScheduledTaskSchema, { ...FULL, tz: 'Mars/Olympus' })).toContain('not a known IANA')
  })

  test('requires a timezone at all', () => {
    expect(validatedScheduledTaskSchema.safeParse({ ...FULL, tz: '' }).success).toBe(false)
  })

  test('requires a prompt -- a schedule with none is a no-op spawn', () => {
    expect(errorOf(validatedScheduledTaskSchema, { ...FULL, prompt: '' })).toContain('prompt is required')
  })

  test('rejects an oversized prompt', () => {
    expect(errorOf(validatedScheduledTaskSchema, { ...FULL, prompt: 'x'.repeat(64 * 1024 + 1) })).toContain('64 KB')
  })

  test('requires projectUri and cwd', () => {
    expect(validatedScheduledTaskSchema.safeParse({ ...FULL, projectUri: '' }).success).toBe(false)
    expect(validatedScheduledTaskSchema.safeParse({ ...FULL, cwd: '' }).success).toBe(false)
  })

  test('rejects an inverted start/end window', () => {
    expect(errorOf(validatedScheduledTaskSchema, { ...FULL, startAt: 5000, endAt: 1000 })).toContain(
      'endAt must be after startAt',
    )
  })

  test('accepts a valid start/end window', () => {
    expect(validatedScheduledTaskSchema.safeParse({ ...FULL, startAt: 1000, endAt: 5000 }).success).toBe(true)
  })

  test('accepts every cron shape the parser supports', () => {
    for (const cron of ['@daily', '*/15 * * * *', '0 0 13 * fri', '0 9 * * mon,fri']) {
      expect(validatedScheduledTaskSchema.safeParse({ ...FULL, cron }).success).toBe(true)
    }
  })
})

describe('scheduledTaskCreateSchema', () => {
  test('server-owned fields are not required from the client', () => {
    const res = scheduledTaskCreateSchema.safeParse(BASE)
    expect(res.success).toBe(true)
  })

  test('defaults enabled to true', () => {
    const { enabled: _drop, ...withoutEnabled } = BASE
    const res = scheduledTaskCreateSchema.safeParse(withoutEnabled)
    expect(res.success && res.data.enabled).toBe(true)
  })

  test('defaults the overlap and catch-up policies to the safe ones', () => {
    const { catchUp: _c, overlap: _o, ...bare } = BASE
    const res = scheduledTaskCreateSchema.safeParse(bare)
    expect(res.success && res.data.catchUp).toBe('skip')
    expect(res.success && res.data.overlap).toBe('skip')
  })

  test('still validates cron and tz', () => {
    expect(scheduledTaskCreateSchema.safeParse({ ...BASE, cron: 'nonsense' }).success).toBe(false)
    expect(scheduledTaskCreateSchema.safeParse({ ...BASE, tz: 'Nowhere/Fake' }).success).toBe(false)
  })
})

describe('scheduledTaskPatchSchema', () => {
  test('an empty patch is valid', () => {
    expect(scheduledTaskPatchSchema.safeParse({}).success).toBe(true)
  })

  test('a single-field patch is valid', () => {
    expect(scheduledTaskPatchSchema.safeParse({ enabled: false }).success).toBe(true)
  })

  test('re-validates cron and tz when present', () => {
    expect(scheduledTaskPatchSchema.safeParse({ cron: '99 * * * *' }).success).toBe(false)
    expect(scheduledTaskPatchSchema.safeParse({ tz: 'Nowhere/Fake' }).success).toBe(false)
    expect(scheduledTaskPatchSchema.safeParse({ cron: '@hourly' }).success).toBe(true)
  })
})

describe('ids and defaults', () => {
  test('ids carry their prefix and are unique', () => {
    expect(newScheduledTaskId()).toStartWith('sch_')
    expect(newScheduledRunId()).toStartWith('schrun_')
    expect(newScheduledTaskId()).not.toBe(newScheduledTaskId())
  })

  test('the default spawn is ad-hoc and exits after its turn', () => {
    // If this ever flips, every scheduled run leaks a live session.
    expect(DEFAULT_SCHEDULE_SPAWN.adHoc).toBe(true)
    expect(DEFAULT_SCHEDULE_SPAWN.leaveRunning).toBe(false)
    expect(DEFAULT_SCHEDULE_SPAWN.headless).toBe(true)
  })
})
