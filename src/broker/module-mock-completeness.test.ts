/**
 * THE CLASS-WIDE GUARD: no `mock.module()` factory may return fewer exports than
 * the module it replaces declares.
 *
 * Bun's module mocks are process-global and permanent, and the factory REPLACES
 * the module record -- so every export the factory omits ceases to exist for
 * every file LINKED afterwards in the same `bun test` process. The importer then
 * dies with
 *
 *   SyntaxError: Export named '<x>' not found in module <path>
 *
 * in a file that has nothing to do with the mock, and the error reads like a
 * missing export rather than a test-isolation bug. It has cost this repo twice:
 * `nightshift-orchestrator` (2 of 9, took down 4 unrelated test files the moment
 * `bun test` was given two directories) and `./push` (2 of 7, latent only because
 * no importer of the other 5 happened to link later).
 *
 * `nightshift-orchestrator-no-module-mock.test.ts` bans one module by name. This
 * bans the SHAPE, so the next one never has to be discovered by an outage.
 *
 * A factory that spreads the real module (`...(await import('./x'))`) is fine and
 * is reported as opaque -- it cannot drop anything.
 *
 * THE FIX when this fails is never "add the missing keys": it is a seam.
 * `configurePushIo` / `resetPushIo` in `push.ts` and `configureNightshiftIo` /
 * `resetNightshiftIo` in `nightshift-orchestrator.ts` are the two worked examples.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { findModuleMockCalls, valueExportsOf } from './module-mock-scan'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCAN_ROOTS = ['src', 'web/src'].map(r => join(REPO_ROOT, r)).filter(existsSync)

/** Every `.test.ts` / `.test.tsx` under a root, recursively. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) testFiles(full, out)
    else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

/** The file a relative specifier points at, or null for a package/builtin. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Human-readable complaints about one test file's mock.module calls. */
function auditFile(file: string): string[] {
  const rel = file.slice(REPO_ROOT.length + 1)
  const offences: string[] = []
  for (const call of findModuleMockCalls(readFileSync(file, 'utf8'), rel)) {
    if (call.opaque) continue
    const target = resolveSpecifier(file, call.specifier)
    // A bare package specifier has no source here to compare against.
    if (!target) continue
    const declared = valueExportsOf(readFileSync(target, 'utf8'))
    const missing = declared.filter(name => !call.keys.includes(name))
    if (missing.length === 0) continue
    offences.push(
      `${rel}:${call.line} mocks '${call.specifier}' with ${call.keys.length}/${declared.length} exports -- ` +
        `missing: ${missing.join(', ')}`,
    )
  }
  return offences
}

describe('mock.module factories must be complete', () => {
  test('no factory returns fewer exports than its target declares', () => {
    const offences = SCAN_ROOTS.flatMap(root => testFiles(root)).flatMap(auditFile)
    expect(offences).toEqual([])
  })

  test('the scan actually reaches the test files (a guard that finds nothing guards nothing)', () => {
    const found = SCAN_ROOTS.flatMap(root => testFiles(root))
    expect(found.length).toBeGreaterThan(100)
    expect(found).toContain(join(REPO_ROOT, 'src/broker/attention-notify-ceiling.test.ts'))
  })

  test('push.ts exposes the seam that replaced its module mock', async () => {
    const push = await import('./push')
    expect(typeof push.configurePushIo).toBe('function')
    expect(typeof push.resetPushIo).toBe('function')
    // The symptom itself: all seven value exports still resolve.
    for (const name of [
      'initPush',
      'isPushConfigured',
      'addSubscription',
      'removeSubscription',
      'getSubscriptionCount',
      'sendPushToUser',
      'sendPushToAll',
    ] as const) {
      expect(typeof push[name]).toBe('function')
    }
  })
})
