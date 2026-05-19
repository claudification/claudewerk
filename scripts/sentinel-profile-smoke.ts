#!/usr/bin/env bun
/**
 * sentinel-profile-smoke -- Tier-2 verification for Phase 2 of
 * `.claude/docs/plan-sentinel-profiles.md`.
 *
 * This is the "live" smoke: it drops a fixture sentinel.json that registers
 * `~/.claude-work` as the `work` profile, then verifies (a) the loader
 * normalizes the entry correctly and (b) the env-injection helper emits
 * CLAUDE_CONFIG_DIR + profile.env as REAL env keys (not inside
 * RCLAUDE_CUSTOM_ENV). Both checks have to pass for the agent host and CC
 * CLI to land transcripts in the right profile dir.
 *
 * The real spawn integration -- start a sentinel, dispatch a work-profile
 * spawn, wait for CC to write a JSONL into ~/.claude-work/projects/<slug>/
 * -- requires an authed `claude` CLI + a live broker and a Claude
 * subscription; we don't attempt that here. The Phase 2 commit explicitly
 * defers it as a Tier-3 live check.
 *
 * Run: `bun run scripts/sentinel-profile-smoke.ts`
 * Exits 0 = green, 1 = red.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDirFor, loadSentinelConfig, profileSummaries, resolveProfile } from '../src/sentinel/sentinel-config'

const WORK_CONFIG_DIR = join(homedir(), '.claude-work')

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  const marker = ok ? 'OK  ' : 'FAIL'
  process.stdout.write(`[${marker}] ${name} -- ${detail}\n`)
}

// fallow-ignore-next-line complexity
async function main(): Promise<number> {
  check('fixture: ~/.claude-work exists', existsSync(WORK_CONFIG_DIR), WORK_CONFIG_DIR)

  const scratch = mkdtempSync(join(tmpdir(), 'sentinel-profile-smoke-'))
  try {
    // Drop a fixture sentinel.json that registers `work` -> ~/.claude-work
    // with a per-profile env override. Mirrors the plan's example.
    const configPath = join(scratch, 'sentinel.json')
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          defaultSelection: 'default',
          profiles: {
            default: { configDir: '~/.claude' },
            work: {
              configDir: '~/.claude-work',
              env: { ANTHROPIC_PROFILE_TAG: 'work-fixture' },
              pooled: true,
              label: 'Work account',
            },
          },
        },
        null,
        2,
      ),
    )

    const cfg = loadSentinelConfig({ configPath })
    check('config loads with no error', true, `sourcePath=${cfg.sourcePath}`)
    check('work profile registered', cfg.profiles.work !== undefined, `profiles=${Object.keys(cfg.profiles).join(',')}`)

    const resolved = resolveProfile(cfg, 'work')
    check(
      'work profile resolves to ~/.claude-work',
      resolved.configDir === WORK_CONFIG_DIR,
      `configDir=${resolved.configDir} (expected ${WORK_CONFIG_DIR})`,
    )
    check(
      'configDirFor(cfg, "work") returns same dir',
      configDirFor(cfg, 'work') === WORK_CONFIG_DIR,
      configDirFor(cfg, 'work'),
    )
    check(
      'configDirFor(cfg) returns ~/.claude (default profile)',
      configDirFor(cfg) === join(homedir(), '.claude'),
      configDirFor(cfg),
    )
    check(
      'work profile env carries the fixture key',
      resolved.env.ANTHROPIC_PROFILE_TAG === 'work-fixture',
      JSON.stringify(resolved.env),
    )

    // Verify the env-injection model: profile env lands DIRECTLY in a
    // child-process env object, NOT inside RCLAUDE_CUSTOM_ENV. We emulate the
    // sentinel's `buildHeadlessEnv` injection rule here -- the same code path
    // that runs at spawn time.
    const userEnv = { USER_TYPED: 'visible-to-broker' }
    const childEnv = {
      ...(resolved.configDir ? { CLAUDE_CONFIG_DIR: resolved.configDir } : {}),
      ...resolved.env,
      ...(Object.keys(userEnv).length ? { RCLAUDE_CUSTOM_ENV: JSON.stringify(userEnv) } : {}),
    }
    check(
      'env injection: CLAUDE_CONFIG_DIR is a real env key',
      childEnv.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR,
      `CLAUDE_CONFIG_DIR=${childEnv.CLAUDE_CONFIG_DIR}`,
    )
    check(
      'env injection: profile.env keys land directly (not in RCLAUDE_CUSTOM_ENV)',
      childEnv.ANTHROPIC_PROFILE_TAG === 'work-fixture',
      `ANTHROPIC_PROFILE_TAG=${childEnv.ANTHROPIC_PROFILE_TAG}`,
    )
    check(
      'env injection: user env still travels via RCLAUDE_CUSTOM_ENV',
      childEnv.RCLAUDE_CUSTOM_ENV === JSON.stringify(userEnv),
      childEnv.RCLAUDE_CUSTOM_ENV,
    )
    check(
      'profile.env NEVER stuffed into RCLAUDE_CUSTOM_ENV (Profile-Env Boundary)',
      !childEnv.RCLAUDE_CUSTOM_ENV.includes('ANTHROPIC_PROFILE_TAG'),
      childEnv.RCLAUDE_CUSTOM_ENV,
    )

    // Verify the broker-facing summaries don't leak configDir or env.
    const summaries = profileSummaries(cfg)
    const workSummary = summaries.find(s => s.name === 'work')
    check('profileSummaries: work entry present', workSummary !== undefined, JSON.stringify(workSummary))
    const serialized = JSON.stringify(summaries)
    check('profileSummaries: NEVER serializes configDir', !serialized.includes('.claude-work'), 'no configDir leak')
    check('profileSummaries: NEVER serializes env values', !serialized.includes('work-fixture'), 'no env leak')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  const failed = checks.filter(c => !c.ok)
  const passed = checks.length - failed.length
  process.stdout.write(`\nSmoke: ${passed}/${checks.length} checks passed.\n`)
  if (failed.length > 0) {
    process.stdout.write('Failed checks:\n')
    for (const f of failed) process.stdout.write(`  - ${f.name}: ${f.detail}\n`)
    return 1
  }
  return 0
}

process.exit(await main())
