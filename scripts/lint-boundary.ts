#!/usr/bin/env bun

/**
 * Boundary lint: enforces that the broker NEVER reads or interprets CC-specific
 * concepts. The broker is a conversation router -- CC session IDs, CC-specific
 * fields, and CC internal state are agent-host concepts that the broker passes
 * through as opaque metadata.
 *
 * RULE 1-3 (ccSessionId / sessionId / profile-env): src/broker/ must NEVER
 * reference `ccSessionId`, bare `sessionId`, `configDir`, or `profile.env` as a
 * typed field. The opaque `agentHostMeta` bag carries them; the broker never
 * peeks inside.
 *
 * RULE transportMeta (transport reframe -- plan-claude-transport-reframe.md
 * § 0.3 / § 4.5): `transportMeta` is a backend-specific opaque bag, parallel to
 * agentHostMeta. ONLY a backend implementation (src/broker/backends/*.ts), the
 * sentinel spawn path (src/sentinel/spawn/*), and the agent hosts
 * (src/daemon-agent-host/*, src/claude-agent-host/*) may READ its contents. The
 * broker core (src/broker/ outside backends/), src/shared/ outside the type
 * definition, and web/src/ must NEVER read `.transportMeta` -- they see the
 * `transport` discriminator and the typed launchConfig, not the raw bag.
 * Constructing the bag (an object-literal `transportMeta:` write) is allowed
 * anywhere; only READS (`.transportMeta` access) are gated.
 *
 * Run: `bun run scripts/lint-boundary.ts`
 * Exits 0 = clean, 1 = violations found.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'

export const REPO_ROOT = join(import.meta.dir, '..')

export interface BoundaryViolation {
  /** Repo-relative path, display-ready. */
  file: string
  line: number
  text: string
  reason: string
}

const ALLOWED_CCSESSION_FILES = new Set([
  'handlers/boot-lifecycle.ts',
  'handlers/conversation-lifecycle.ts',
  'handlers/sentinel.ts',
  // handlers/daemon.ts: daemon_session_retired carries a forensic ccSessionId
  // that the handler writes into the opaque agentHostMeta bag (write-only). The
  // handler MUST NOT branch on it; the script enforces that below.
  'handlers/daemon.ts',
  'build-revive.ts',
  'spawn-dispatch.ts',
  'conversation-store.ts',
])

/**
 * RULE 4 (CWD-IS-INFORMATIONAL covenant): in the broker, a raw filesystem `cwd`
 * is INFORMATIONAL ONLY (logs, display labels, opaque passthrough to the
 * sentinel). It must NEVER drive logic. The project URI (`claude://...`) is the
 * sole identity; the SENTINEL owns URI<->path resolution. Two patterns are the
 * tell that the broker is doing path LOGIC and are gated below:
 *
 *   4a. `parseProjectUri(x).path` -- extracting a raw path OUT of a URI so the
 *       broker can use it. The broker should forward the URI and let the
 *       sentinel resolve it.
 *   4b. `cwdToProjectUri(x)` -- deriving the canonical identity FROM a raw path
 *       at runtime. Conversion belongs at the agent-host / sentinel boundary,
 *       not in broker core.
 *
 * Both allowlists are GRANDFATHERED: they freeze the current footprint so NO NEW
 * file can introduce broker cwd-logic. `.claude/docs/plan-broker-cwd-eradication.md`
 * drives them to zero. DO NOT ADD to either set -- if you reach for one, the
 * conversion belongs on the sentinel.
 */
const ALLOWED_URI_PATH_EXTRACTION_FILES = new Set([
  // Sends the path to the sentinel in `project_watch` / `project_unwatch`. The
  // wire message already carries the URI too; the plan moves extraction
  // sentinel-side so the broker forwards the URI only.
  'project-watch-registry.ts',
])
const ALLOWED_CWD_TO_URI_FILES = new Set([
  // --- Legacy one-time migrations: read an OLD persisted `cwd` column / field
  //     and upgrade it to a URI exactly once. Defensible long-term.
  'project-store.ts',
  'project-links.ts',
  'project-settings.ts',
  'project-order.ts',
  'analytics-store.ts',
  'conversation-store.ts',
  'conversation-store/project-links.ts',
  'permissions.ts',
  // --- Runtime inbound-path conversion at the spawn / boot wire seam. These
  //     are the real targets of the eradication plan: a raw `cwd` arrives from
  //     the agent-host / sentinel and is converted in broker core. The plan
  //     pushes the conversion onto the sentinel so the URI arrives pre-formed.
  'handlers/boot-lifecycle.ts',
  'handlers/conversation-lifecycle.ts',
  'handlers/daemon.ts',
  'backends/claude-daemon.ts',
  'backends/opencode.ts',
  // spawn-dispatch.ts: the spawn-request entry seam. `SpawnRequest.cwd` is the
  // ONE place a raw path legitimately arrives (MCP `cwd` param) and is converted
  // for the pre-dispatch project-settings lookup. The architectural root of the
  // plan -- canonicalize at the sentinel so the URI is formed before dispatch.
  'spawn-dispatch.ts',
  // shares.ts: normalizes a share's `project` at ingest. The plan types
  // `ConversationShare.project` URI-only so this fallback disappears.
  'shares.ts',
])

/** Lines that are pure comments or that embed the token only inside a string
 *  literal are documentation, not logic -- never a boundary violation. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/**
 * Rules 1-3: the broker must never interpret CC session ids or profile
 * credentials. Scans src/broker only.
 */
export function findBrokerBoundaryViolations(): BoundaryViolation[] {
  const brokerDir = join(REPO_ROOT, 'src/broker')
  const files = [...new Glob('**/*.ts').scanSync({ cwd: brokerDir })]
  const violations: BoundaryViolation[] = []

  for (const relPath of files) {
    if (relPath.endsWith('.d.ts')) continue
    if (relPath.includes('__tests__/')) continue
    // Test files legitimately reference configDir / env in fixtures (e.g. asserting
    // the broker DROPS them). They are not broker runtime code.
    if (relPath.endsWith('.test.ts')) continue

    const content = readFileSync(join(brokerDir, relPath), 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1
      if (isCommentLine(line)) continue

      // Rule 1: No .ccSessionId property access in broker (except allowed files storing it)
      if (/\.ccSessionId\b/.test(line)) {
        if (ALLOWED_CCSESSION_FILES.has(relPath)) {
          // Allowed files may WRITE to agentHostMeta but not use it in logic
          if (/if\s*\(.*\.ccSessionId|===.*ccSessionId|!==.*ccSessionId/.test(line)) {
            violations.push({
              file: `src/broker/${relPath}`,
              line: lineNum,
              text: line.trim(),
              reason: 'Broker must not branch on ccSessionId (CC concept, opaque to broker)',
            })
          }
        } else {
          violations.push({
            file: `src/broker/${relPath}`,
            line: lineNum,
            text: line.trim(),
            reason: 'Broker must not access ccSessionId (CC concept, opaque to broker)',
          })
        }
      }

      // Rule 2: No `sessionId` (without cc prefix) as a field in broker code
      // (but allow `fromSessionId`/`toSessionId` in inter-conversation routing,
      // and `$sessionId` SQL bind params that map to conversation_id columns in legacy schemas)
      if (/\bsessionId\b/.test(line) && !/ccSessionId|fromSessionId|toSessionId/.test(line)) {
        // Allow in SQL strings (bind param name doesn't matter, just the column name)
        if (/\$sessionId|\$conversationId/.test(line)) continue
        // Allow in migration code (reads old data formats)
        if (relPath.includes('migrate')) continue
        // Allow in string literals (error messages referencing the old name)
        if (/['"`].*sessionId.*['"`]/.test(line)) continue
        violations.push({
          file: `src/broker/${relPath}`,
          line: lineNum,
          text: line.trim(),
          reason: 'Broker must not use bare `sessionId` (use conversationId)',
        })
      }

      // Rule 3 (sentinel-profiles): the broker stores the profile NAME only.
      // Reading `configDir` or `profile.env` is a Profile-Env Boundary violation
      // -- credentials live on the sentinel. See `.claude/docs/plan-sentinel-
      // profiles.md` Profile-Env Boundary covenant.
      if (/\bconfigDir\b/.test(line)) {
        // Allow string-literal references (error messages, log strings).
        if (!/['"`].*configDir.*['"`]/.test(line)) {
          violations.push({
            file: `src/broker/${relPath}`,
            line: lineNum,
            text: line.trim(),
            reason:
              "Broker must not read `configDir` -- it's a sentinel-side concept (Profile-Env Boundary). " +
              'The broker stores the profile NAME only.',
          })
        }
      }
      // Rule 3b (sentinel-profiles Phase 8): a `sentinel_patch_config` site must
      // never name `env` or `configDir`. The patch wire type is the broker-tunable
      // subset (weight / pool / label / color / defaultSelection / defaultPool)
      // and deliberately omits the secret-bearing fields. This catches a future
      // edit that tries to widen the patch to carry filesystem / credential
      // fields. See `.claude/docs/plan-sentinel-profiles.md` Phase 8.
      if (/sentinel_patch_config/.test(line) && /\b(env|configDir)\b/.test(line)) {
        // Allow comment / string-literal references that merely DOCUMENT the ban.
        if (!/['"`].*(env|configDir).*['"`]/.test(line)) {
          violations.push({
            file: `src/broker/${relPath}`,
            line: lineNum,
            text: line.trim(),
            reason:
              'sentinel_patch_config must not carry `env` / `configDir` -- the broker-tunable patch ' +
              'is NAME/display/routing only (Profile-Env Boundary, plan Phase 8).',
          })
        }
      }

      // `profile.env` is a property access into a sentinel-resident bundle.
      // Match both `profile.env` (dot-access) and `.env` immediately after a
      // `profile` reference. We deliberately do NOT flag `LaunchConfig.env`
      // (that's the user-typed env, broker-safe).
      if (/\bprofile\.env\b/.test(line)) {
        if (!/['"`].*profile\.env.*['"`]/.test(line)) {
          violations.push({
            file: `src/broker/${relPath}`,
            line: lineNum,
            text: line.trim(),
            reason:
              'Broker must not read `profile.env` -- API keys / configDir live sentinel-side ' +
              '(Profile-Env Boundary). Forward NAMES only.',
          })
        }
      }

      // Rule 4a (CWD-IS-INFORMATIONAL): extracting a raw path OUT of a project
      // URI (`parseProjectUri(x).path`) is path LOGIC -- the broker should
      // forward the URI and let the sentinel resolve the path.
      if (/\b(try)?[pP]arseProjectUri\([^)]*\)\.path\b/.test(line) && !ALLOWED_URI_PATH_EXTRACTION_FILES.has(relPath)) {
        violations.push({
          file: `src/broker/${relPath}`,
          line: lineNum,
          text: line.trim(),
          reason:
            'Broker must not extract `.path` from a project URI (CWD-IS-INFORMATIONAL). ' +
            'Forward the URI; the sentinel owns URI->path resolution.',
        })
      }

      // Rule 4b (CWD-IS-INFORMATIONAL): deriving the canonical identity FROM a
      // raw path at runtime (`cwdToProjectUri(x)`) is path LOGIC -- conversion
      // belongs at the agent-host / sentinel boundary, not in broker core.
      if (/\bcwdToProjectUri\(/.test(line) && !ALLOWED_CWD_TO_URI_FILES.has(relPath)) {
        // String-literal / comment references that merely DOCUMENT the ban are fine.
        if (!/['"`][^'"`]*cwdToProjectUri[^'"`]*['"`]/.test(line)) {
          violations.push({
            file: `src/broker/${relPath}`,
            line: lineNum,
            text: line.trim(),
            reason:
              'Broker must not call `cwdToProjectUri` (CWD-IS-INFORMATIONAL) -- raw paths must ' +
              'not reach broker core. Resolve URIs at the sentinel / agent-host boundary.',
          })
        }
      }
    }
  }
  return violations
}

/** Roots scanned for the transportMeta read rule, each repo-relative. */
const TRANSPORT_META_SCAN_ROOTS = ['src/broker', 'src/shared', 'web/src']

/**
 * A file allowed to READ `transportMeta`. The backend implementations own the
 * bag; the two src/shared files DEFINE the type + the cross-field refinement
 * that reads it. Everything else in the scanned roots is forbidden. The
 * sentinel spawn path and the agent hosts are allowed too, but they live
 * outside the scanned roots so they are implicitly permitted (never visited).
 */
export function isTransportMetaReader(repoRelPath: string): boolean {
  if (repoRelPath.startsWith('src/broker/backends/')) return true
  if (repoRelPath === 'src/shared/spawn-schema.ts') return true
  if (repoRelPath === 'src/shared/protocol.ts') return true
  return false
}

/**
 * Is this source line a READ of the opaque `transportMeta` bag? A read is a
 * `.transportMeta` property access. Object-literal `transportMeta:` writes
 * (constructing a SpawnRequest), comment lines, and string-literal references
 * (log lines mentioning the field name) are NOT reads.
 */
export function isTransportMetaReadLine(line: string): boolean {
  if (isCommentLine(line)) return false
  if (!/\.transportMeta\b/.test(line)) return false
  // A `.transportMeta` token wholly inside a string literal is documentation.
  if (/['"`][^'"`]*\.transportMeta[^'"`]*['"`]/.test(line)) return false
  return true
}

const TRANSPORT_META_REASON =
  'transportMeta is a backend-specific opaque bag -- only src/broker/backends/*, the sentinel ' +
  'spawn path, and the agent hosts may read it. See plan-claude-transport-reframe.md § 0.3.'

/**
 * Pure per-file scan for the transportMeta read rule. Exported so tests can
 * feed synthetic content for both allowed and disallowed paths.
 */
export function transportMetaReadsInFile(repoRelPath: string, content: string): BoundaryViolation[] {
  if (isTransportMetaReader(repoRelPath)) return []
  const violations: BoundaryViolation[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!isTransportMetaReadLine(lines[i])) continue
    violations.push({ file: repoRelPath, line: i + 1, text: lines[i].trim(), reason: TRANSPORT_META_REASON })
  }
  return violations
}

/**
 * RULE transportMeta: flag any READ of the opaque `transportMeta` bag
 * (`.transportMeta` property access) outside the whitelist. Object-literal
 * `transportMeta:` writes (constructing a SpawnRequest) are NOT reads and are
 * allowed everywhere. Mirrors the agentHostMeta / ccSessionId opaque-bag rule.
 */
export function findTransportMetaViolations(): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []
  for (const root of TRANSPORT_META_SCAN_ROOTS) {
    const rootDir = join(REPO_ROOT, root)
    const files = [...new Glob('**/*.{ts,tsx}').scanSync({ cwd: rootDir })]
    for (const relPath of files) {
      if (relPath.endsWith('.d.ts')) continue
      if (relPath.includes('__tests__/')) continue
      if (relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')) continue
      const repoRel = `${root}/${relPath}`
      const content = readFileSync(join(rootDir, relPath), 'utf-8')
      violations.push(...transportMetaReadsInFile(repoRel, content))
    }
  }
  return violations
}

function main(): void {
  const violations = [...findBrokerBoundaryViolations(), ...findTransportMetaViolations()]
  if (violations.length === 0) {
    console.log('[boundary-lint] PASS -- no broker boundary violations')
    process.exit(0)
  }
  console.error(`[boundary-lint] FAIL -- ${violations.length} violation(s):\n`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(`    reason: ${v.reason}\n`)
  }
  process.exit(1)
}

if (import.meta.main) main()
