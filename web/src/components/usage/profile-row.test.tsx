/**
 * The usage popover identifies each profile with the SAME tinted chip the
 * conversation list uses (`[A]`, `[B]`).
 *
 * Regression guards:
 *   1. the chip renders, tinted by the profile's color;
 *   2. `showLabel: false` does NOT hide it here -- that opt-out only silences
 *      the badge on conversation rows; this panel exists to tell profiles
 *      apart, so it always shows;
 *   3. an errored ("not authed") row still gets the chip;
 *   4. a profile with no label gets no chip (nothing to put in the box).
 */

import type { ProfileUsageSnapshot, SentinelProfileInfo } from '@shared/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

let profiles: SentinelProfileInfo[] = []

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: (sel: (s: { sentinels: unknown[] }) => unknown) =>
    sel({ sentinels: [{ sentinelId: 'snt_1', alias: 'default', profiles }] }),
}))

const { ProfileRow } = await import('./profile-row')

function profile(over: Partial<SentinelProfileInfo> & { name: string }): SentinelProfileInfo {
  return { pool: 'default', weight: 1, authed: true, ...over } as SentinelProfileInfo
}

function snapshot(over: Partial<ProfileUsageSnapshot> & { profile: string }): ProfileUsageSnapshot {
  return {
    authed: true,
    polledAt: 1_700_000_000_000,
    fiveHour: { usedPercent: 53, resetAt: new Date(1_700_000_000_000).toISOString() },
    sevenDay: { usedPercent: 46, resetAt: new Date(1_700_000_000_000).toISOString() },
    ...over,
  } as ProfileUsageSnapshot
}

afterEach(() => {
  cleanup()
  profiles = []
})

test('renders the tinted chip for a profile whose badge is hidden on conversation rows', () => {
  profiles = [profile({ name: 'default', label: 'A', color: '#3b82f6', showLabel: false })]
  render(<ProfileRow snap={snapshot({ profile: 'default' })} alias="default" />)

  const chip = screen.getByTitle('Profile: default - A')
  expect(chip.textContent).toBe('A')
  expect(chip.style.color).toBe('rgb(59, 130, 246)')
  // The raw profile name stays alongside the chip.
  expect(screen.getByText('default')).toBeTruthy()
})

test('an errored profile row still shows its chip', () => {
  profiles = [profile({ name: 'work', label: 'B', color: '#f59e0b' })]
  render(
    <ProfileRow
      snap={snapshot({
        profile: 'work',
        authed: false,
        fiveHour: undefined,
        sevenDay: undefined,
        error: { kind: 'no_token' },
      })}
      alias="default"
    />,
  )

  expect(screen.getByTitle('Profile: work - B').textContent).toBe('B')
  expect(screen.getByText('not authed')).toBeTruthy()
})

test('a profile with no label gets no chip', () => {
  profiles = [profile({ name: 'work' })]
  render(<ProfileRow snap={snapshot({ profile: 'work' })} alias="default" />)

  expect(screen.queryByTitle(/^Profile: /)).toBeNull()
})

// ─── login-expiry countdown ────────────────────────────────────────
//
// The deadline past which only `/login` restores the profile. Deliberately
// silent while the login is healthy: a countdown on every row would be chrome
// nobody reads, which is exactly how the one row that matters gets missed.

const DAY = 86_400_000

test('says nothing about a login that is weeks away', () => {
  profiles = [profile({ name: 'work' })]
  render(<ProfileRow snap={snapshot({ profile: 'work', authExpiresAt: Date.now() + 27 * DAY })} alias="default" />)

  expect(screen.queryByText(/login/)).toBeNull()
})

test('says nothing when the sentinel reported no deadline at all', () => {
  profiles = [profile({ name: 'work' })]
  render(<ProfileRow snap={snapshot({ profile: 'work' })} alias="default" />)

  expect(screen.queryByText(/login/)).toBeNull()
})

test('counts down once the login enters the warning horizon', () => {
  profiles = [profile({ name: 'work' })]
  render(<ProfileRow snap={snapshot({ profile: 'work', authExpiresAt: Date.now() + 2 * DAY })} alias="default" />)

  expect(screen.getByText('login 2d')).toBeTruthy()
})

test('an errored row shows the expired login that explains the error', () => {
  // The whole point of carrying the deadline through the error path: "not
  // authed" alone leaves you guessing, "login expired" tells you what to do.
  profiles = [profile({ name: 'work' })]
  render(
    <ProfileRow
      snap={snapshot({
        profile: 'work',
        authed: true,
        fiveHour: undefined,
        sevenDay: undefined,
        error: { kind: 'http', status: 401 },
        authExpiresAt: Date.now() - DAY,
      })}
      alias="default"
    />,
  )

  expect(screen.getByText('login expired')).toBeTruthy()
})
