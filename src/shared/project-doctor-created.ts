/**
 * AUTO-REPAIR: stamp a missing `created:` from the filesystem.
 *
 * The doctor's ONE exception to report-only, and the principle behind it is
 * worth generalising: if the fix is unambiguous and the data is already on
 * disk, REPAIRING beats REPORTING. A card with no `created:` is not something
 * anyone needs told twice -- the filesystem already knows roughly when the file
 * appeared, and a permanent info line nobody actions is exactly how you train
 * people to stop reading the doctor.
 *
 * It is information-preserving by construction: it can only ADD a key that was
 * not saying anything. That is what makes writing-by-default defensible for a
 * tool whose other 15 checks never touch a byte.
 *
 * What it will NOT do, because these are judgements and not repairs:
 *   - touch a `created:` that already parses as a date, whatever its format --
 *     normalising formats is a different job with a different blast radius;
 *   - synthesise a frontmatter block for a card that has none, since
 *     `card-no-frontmatter` reports that and a body opening with `---` would
 *     get eaten;
 *   - write a timestamp it does not believe (see `plausible`).
 *
 * The stamp is a FILESYSTEM GUESS, not a recovered fact: a card that was copied
 * or checked out carries the date it landed, not the date it was written. The
 * finding names the stat it used so the guess stays legible -- `birthtime`
 * really is creation, `ctime` on macOS is inode-CHANGE time (a chmod moves it),
 * and `mtime` is only the last edit. The board is gitignored, so there is no
 * history to recover a truer date from; the filesystem is the only source there
 * is.
 */

import { statSync, writeFileSync } from 'node:fs'
import { parseFrontmatter } from './frontmatter'
import { serializeCard } from './project-card-file'
import type { DoctorFinding } from './project-doctor-types'

/** `off` skips the pass entirely, `preview` reports without writing, `write`
 *  repairs. Default is `off` everywhere except the CLI -- see project-doctor.ts. */
export type RepairMode = 'off' | 'write' | 'preview'

export interface CardStat {
  birthtimeMs: number
  ctimeMs: number
  mtimeMs: number
}

/** Injected so the whole pass is testable without a filesystem whose birthtime
 *  you cannot set. */
export interface CreatedStampDeps {
  stat: (abs: string) => CardStat | null
  write: (abs: string, content: string) => void
  nowMs: number
}

export interface StampTarget {
  id: string
  abs: string
  /** Raw file contents, or null when the file could not be read. */
  content: string | null
}

/** Ordered best-to-worst. `birthtime` is the only one that means what the key
 *  says; the other two are consolation prizes and the finding admits it. */
const SOURCES = [
  { key: 'birthtimeMs', label: 'birthtime', gloss: 'the file was created then' },
  { key: 'ctimeMs', label: 'ctime', gloss: 'inode change time, not birth time' },
  { key: 'mtimeMs', label: 'mtime', gloss: 'last modified, so no earlier than creation' },
] as const

/** Nothing before this is a real card. Filesystems report 0 for an absent
 *  birthtime, and 0 renders as 1970 -- a date confidently wrong by 56 years is
 *  worse than no date at all. */
const FLOOR_MS = Date.parse('1990-01-01T00:00:00.000Z')
/** A stat an hour ahead is clock skew; a stat a year ahead is garbage. */
const SKEW_MS = 24 * 3600_000

function plausible(ms: number | undefined, nowMs: number): boolean {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > FLOOR_MS && ms <= nowMs + SKEW_MS
}

interface Stamp {
  iso: string
  label: string
  gloss: string
}

/** First stat we actually believe, or null when the file's whole triple is junk. */
function pickStamp(stat: CardStat, nowMs: number): Stamp | null {
  for (const source of SOURCES) {
    const ms = stat[source.key]
    if (plausible(ms, nowMs)) return { iso: new Date(ms).toISOString(), ...source }
  }
  return null
}

/**
 * Is this `created:` value already saying something?
 *
 * `Date.parse` is the bar deliberately: the board renders `created` by handing
 * it to `new Date`, so anything that parses already works and is none of the
 * repairer's business. Everything else -- absent, empty, and the literal string
 * `undefined` that six live cards picked up from a hand-written template -- is
 * a key that is present but mute, which is the same problem as absent.
 */
function alreadyDated(value: unknown): boolean {
  if (value === undefined || value === null) return false
  const text = String(value).trim()
  return text !== '' && !Number.isNaN(Date.parse(text))
}

function finding(id: string, stamp: Stamp, mode: RepairMode): DoctorFinding {
  const verb = mode === 'preview' ? 'would stamp' : 'stamped'
  return {
    check: 'card-created-stamped',
    severity: 'info',
    subject: id,
    problem: `no usable \`created:\` -- ${verb} ${stamp.iso} from the file's ${stamp.label} (${stamp.gloss})`,
    remedy:
      mode === 'preview'
        ? 'run board:doctor without --dry-run to write it'
        : 'nothing to do -- it is a filesystem guess, so edit `created:` if you know the real date',
  }
}

/**
 * Repair one card's `created:`, or decide not to. Returns the single info
 * finding when it acted, and an empty list every other time -- including on a
 * second run over an already-stamped card, which is what makes the pass safe to
 * leave on by default.
 */
export function stampMissingCreated(card: StampTarget, mode: RepairMode, deps: CreatedStampDeps): DoctorFinding[] {
  if (mode === 'off' || card.content === null) return []
  // No fences means no frontmatter to patch: parseFrontmatter would hand back
  // the whole file as a body and serializeCard would wrap it in a block it never
  // had. `card-no-frontmatter` already reports this one.
  if (!card.content.startsWith('---')) return []

  const { meta, body, raw } = parseFrontmatter(card.content)
  if (alreadyDated(meta.created)) return []

  const stat = deps.stat(card.abs)
  const stamp = stat && pickStamp(stat, deps.nowMs)
  if (!stamp) return []

  if (mode === 'write') {
    try {
      deps.write(card.abs, serializeCard({ ...meta, created: stamp.iso }, body, raw))
    } catch {
      // A stamp that did not land must not be reported as one. The card keeps
      // its mute `created:` and the next run will try again.
      return []
    }
  }
  return [finding(card.id, stamp, mode)]
}

/** The real filesystem. `nowMs` is the ceiling every stat is judged against. */
export function fsStampDeps(nowMs: number): CreatedStampDeps {
  return {
    nowMs,
    stat: abs => {
      try {
        const s = statSync(abs)
        return { birthtimeMs: s.birthtimeMs, ctimeMs: s.ctimeMs, mtimeMs: s.mtimeMs }
      } catch {
        return null
      }
    },
    write: (abs, content) => writeFileSync(abs, content, 'utf8'),
  }
}
