#!/usr/bin/env bun
/**
 * sentinel-profile-usage-smoke
 *
 * End-to-end-ish smoke for the per-profile usage probing + Smart Balance
 * stack. Catches the kind of regressions unit tests can't:
 *
 *   1. macOS Keychain probe ACTUALLY finds tokens for both default and
 *      `~/.claude-work` on this machine. The token discovery is mocked
 *      in `usage-poller.test.ts`; here we exercise the real `security`
 *      shell-out so a refactor to `keychainServiceFor` or a Claude Code
 *      upgrade that changes the service-name scheme gets caught.
 *   2. Smart Balance pickProfile() picks the higher-headroom profile
 *      when given a real config + synthetic snapshots (wires together
 *      `pickProfile` + `usageHeadroomForProfile`'s headroom math
 *      without going through the sentinel's WS loop).
 *   3. Optional --live: actually hit `https://api.anthropic.com/api/
 *      oauth/usage` once per profile and assert both come back authed
 *      with both windows populated.
 *
 * Run: `bun run smoke:profile-usage` (or with --live for #3)
 *
 * Exit codes:
 *   0 = all green
 *   2 = fixture / environment issue (e.g. ~/.claude-work not authed)
 *   1 = real regression -- the code under test misbehaves
 *
 * See `.claude/docs/plan-sentinel-profile-usage.md` Phase 6.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pickProfile } from '../src/sentinel/selection'
import type { ResolvedProfile, SentinelConfig } from '../src/sentinel/sentinel-config'
import { getOAuthToken, keychainServiceFor, pollProfileUsage } from '../src/sentinel/usage-poller'

const FIXTURE_HOME = homedir()
const DEFAULT_CONFIG_DIR = join(FIXTURE_HOME, '.claude')
const WORK_CONFIG_DIR = join(FIXTURE_HOME, '.claude-work')

const args = new Set(process.argv.slice(2))
const LIVE = args.has('--live')

const lines: string[] = []
function ok(msg: string) {
  lines.push(`  [PASS] ${msg}`)
}
function fail(msg: string) {
  lines.push(`  [FAIL] ${msg}`)
}
function info(msg: string) {
  lines.push(`  [INFO] ${msg}`)
}
function section(title: string) {
  lines.push(`\n== ${title} ==`)
}

let failed = 0
let envIssue = false

function record(passed: boolean, msg: string) {
  if (passed) ok(msg)
  else {
    fail(msg)
    failed++
  }
}

// ─── Step 1: real keychain probe for both profiles ─────────────────

section('1. Token discovery (real macOS Keychain probe)')

const defaultService = keychainServiceFor(DEFAULT_CONFIG_DIR, FIXTURE_HOME)
const workService = keychainServiceFor(WORK_CONFIG_DIR, FIXTURE_HOME)
info(`default service:  ${defaultService}`)
info(`work    service:  ${workService}`)

const defaultToken = getOAuthToken(DEFAULT_CONFIG_DIR)
const workToken = getOAuthToken(WORK_CONFIG_DIR)

record(
  !!defaultToken,
  `getOAuthToken("~/.claude") returns a token (${defaultToken ? `${defaultToken.length} chars` : 'null'})`,
)

if (!existsSync(WORK_CONFIG_DIR)) {
  info(`~/.claude-work does not exist on this machine -- skipping work-profile checks.`)
  envIssue = true
} else if (!workToken) {
  info(
    `~/.claude-work exists but has no discoverable token. If this machine should have a work profile, run \`claude auth login\` with CLAUDE_CONFIG_DIR=${WORK_CONFIG_DIR}.`,
  )
  envIssue = true
} else {
  ok(`getOAuthToken("~/.claude-work") returns a token (${workToken.length} chars)`)
}

// ─── Step 2: Smart Balance pick with synthetic snapshots ───────────

section('2. Smart Balance picks the higher-headroom profile')

const cfg: SentinelConfig = {
  sourcePath: null,
  defaultSelection: 'balanced',
  defaultPool: 'default',
  profiles: {
    default: makeResolvedProfile('default'),
    work: makeResolvedProfile('work'),
  },
}

// `default` is 90% used (low headroom), `work` is 15% used (high headroom).
// Smart Balance should pick `work`.
const usageSource = (name: string) => {
  if (name === 'default') return { headroom: 0.1, stale: false }
  if (name === 'work') return { headroom: 0.85, stale: false }
  return undefined
}
const picked = pickProfile(cfg, { input: 'balanced', usage: usageSource, liveLoad: () => 0 })
record(picked.profile.name === 'work', `Balanced picks 'work' (got '${picked.profile.name}')`)
record(picked.reason === 'smart-balance', `reason='smart-balance' (got '${picked.reason}')`)

// Stale telemetry: falls back to live-load. Make `default` busy, `work` idle.
const stalePicked = pickProfile(cfg, {
  input: 'balanced',
  usage: name => ({ headroom: name === 'default' ? 0.99 : 0.0, stale: true }),
  liveLoad: name => (name === 'default' ? 5 : 0),
})
record(
  stalePicked.profile.name === 'work',
  `Stale telemetry: falls back to least-active (got '${stalePicked.profile.name}')`,
)
record(stalePicked.reason === 'least-active', `reason='least-active' (got '${stalePicked.reason}')`)

// ─── Step 3 (live, opt-in): real Anthropic poll for both profiles ──

// fallow-ignore-next-line complexity
async function liveProbe(name: string, configDir: string, hasToken: boolean) {
  if (!hasToken) {
    info(`${name}: skipping live-poll (no token discovered)`)
    return
  }
  const snap = await pollProfileUsage({ name, configDir })
  record(snap.authed === true, `${name}: authed`)
  if (snap.error) {
    // HTTP / network errors during a live poll usually mean the stored OAuth
    // bearer has expired (Claude Code refreshes on use). NOT a code
    // regression -- the code correctly reported the error. Flag as env-issue.
    info(
      `${name}: ${snap.error.kind} error (${snap.error.status ?? snap.error.detail ?? ''}). ` +
        `If status=401, run \`CLAUDE_CONFIG_DIR=${configDir} claude\` once to refresh the keychain bearer.`,
    )
    envIssue = true
    return
  }
  record(!!snap.fiveHour, `${name}: 5h present (${snap.fiveHour?.usedPercent ?? '?'}%)`)
  record(!!snap.sevenDay, `${name}: 7d present (${snap.sevenDay?.usedPercent ?? '?'}%)`)
}

if (LIVE) {
  section('3. LIVE: poll Anthropic /api/oauth/usage for each profile')
  await liveProbe('default', DEFAULT_CONFIG_DIR, !!defaultToken)
  await liveProbe('work', WORK_CONFIG_DIR, !!workToken)
} else {
  section('3. LIVE Anthropic poll')
  info('skipped (pass --live to enable; hits api.anthropic.com)')
}

// ─── Report ───────────────────────────────────────────────────────

console.log(lines.join('\n'))
console.log('')
if (failed > 0) {
  console.log(`-- ${failed} check(s) failed.`)
  process.exit(1)
}
if (envIssue) {
  console.log('-- All exercised checks passed, but environment is incomplete (see [INFO] above). Exit 2.')
  process.exit(2)
}
console.log('-- All green.')
process.exit(0)

// ─── Helpers ──────────────────────────────────────────────────────

function makeResolvedProfile(name: string): ResolvedProfile {
  return {
    name,
    configDir: join(FIXTURE_HOME, name === 'default' ? '.claude' : `.claude-${name}`),
    env: {},
    pool: 'default',
  }
}
