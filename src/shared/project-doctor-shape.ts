/**
 * AUTO-REPAIR: give a mute value back the shape its key declares.
 *
 * Second repair after project-doctor-created.ts, and it earns the same defence.
 * `tags: infra, board` written bare is not read as two tags -- it is read as NO
 * tags (`Array.isArray(meta.tags) ? ... : []`), silently, forever, and the card
 * looks completely fine. The value is already on disk and there is exactly ONE
 * reading of it, so REPAIRING beats REPORTING: a doctor that nags about what it
 * could have fixed itself trains people to stop reading the doctor.
 *
 * UNAMBIGUOUS ONLY, and the validator decides -- `card-schema-validate.ts`
 * attaches a `repair` value to a problem only where no judgement is involved:
 *   - a bare scalar where a list belongs -> comma-split, because a comma-join is
 *     exactly what `serializeFrontmatter` does writing `[a, b]` back out;
 *   - a ONE-item list where a scalar belongs -> unwrapped.
 * A misspelled lane, an unparseable date, a word where a number belongs: those
 * are judgements and stay findings. Longer lists too -- picking a survivor is a
 * choice, and a repairer that discards data is worse than no repairer.
 *
 * It never touches a key the registry does not KNOW (preserve-unknown-keys is a
 * promise) and never a LINKAGE key: `readLinkage` already folds a bare
 * `refs: x` into a list, so the value was never lost and there is nothing to
 * repair -- only a non-canonical spelling that project-doctor-linkage.ts
 * mentions once, at info.
 */

import { writeFileSync } from 'node:fs'
import { cardKeySpec } from './card-schema'
import { cardValueProblem } from './card-schema-validate'
import { parseFrontmatter } from './frontmatter'
import { serializeCard } from './project-card-file'
import type { RepairMode, StampTarget } from './project-doctor-created'
import type { DoctorFinding } from './project-doctor-types'

/** Injected so the pass is testable with no filesystem. */
export interface ShapeRepairDeps {
  write: (abs: string, content: string) => void
}

export interface ShapeRepair {
  findings: DoctorFinding[]
  /** The card's contents AFTER repair -- the caller re-checks against this, so
   *  a value that was just fixed is not also reported as broken. Unchanged
   *  content comes straight back. */
  content: string | null
}

interface Fix {
  key: string
  from: string
  to: string
  value: unknown
}

/** How a value reads on disk, for the finding's before/after. */
function render(value: unknown): string {
  return Array.isArray(value) ? `[${value.map(String).join(', ')}]` : String(value)
}

/** Every unambiguous fix this card's frontmatter admits, in key order. */
function fixesFor(meta: Record<string, unknown>): Fix[] {
  const fixes: Fix[] = []
  for (const [key, value] of Object.entries(meta)) {
    const spec = cardKeySpec(key)
    if (!spec || spec.linkage) continue
    const problem = cardValueProblem(spec, value)
    if (!problem || problem.repair === undefined) continue
    fixes.push({ key, from: render(value), to: render(problem.repair), value: problem.repair })
  }
  return fixes
}

function finding(id: string, fix: Fix, mode: RepairMode): DoctorFinding {
  const verb = mode === 'preview' ? 'would rewrite' : 'rewrote'
  return {
    check: 'card-key-reshaped',
    severity: 'info',
    subject: id,
    problem: `\`${fix.key}: ${fix.from}\` was the wrong shape and read as nothing -- ${verb} it as \`${fix.to}\``,
    remedy:
      mode === 'preview'
        ? 'run board:doctor without --dry-run to write it'
        : 'nothing to do -- the value was already on the card, it just could not be read',
  }
}

/**
 * Repair one card's mute values, or decide not to. Returns the info findings for
 * what it did and the card's content afterwards. A second run over a repaired
 * card finds nothing, which is what makes this safe to leave on by default.
 *
 * `preview` patches the returned CONTENT but writes no bytes: the report then
 * reads exactly like a real run's would, minus the writing.
 */
export function repairCardShape(card: StampTarget, mode: RepairMode, deps: ShapeRepairDeps): ShapeRepair {
  if (mode === 'off' || card.content === null) return { findings: [], content: card.content }
  // No fences means no frontmatter to patch: parseFrontmatter would hand back
  // the whole file as a body and serializeCard would wrap it in a block it never
  // had. `card-no-frontmatter` already reports this one.
  if (!card.content.startsWith('---')) return { findings: [], content: card.content }

  const { meta, body } = parseFrontmatter(card.content)
  const fixes = fixesFor(meta)
  if (fixes.length === 0) return { findings: [], content: card.content }

  const patched = { ...meta }
  for (const fix of fixes) patched[fix.key] = fix.value
  const content = serializeCard(patched, body)

  if (mode === 'write') {
    try {
      deps.write(card.abs, content)
    } catch {
      // A repair that did not land must not be reported as one, and the caller
      // must keep checking the ORIGINAL bytes. Next run tries again.
      return { findings: [], content: card.content }
    }
  }
  return { findings: fixes.map(fix => finding(card.id, fix, mode)), content }
}

/** The real filesystem. */
export function fsShapeRepairDeps(): ShapeRepairDeps {
  return { write: (abs, content) => writeFileSync(abs, content, 'utf8') }
}
