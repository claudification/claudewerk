import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'
import { type Aspect, type AspectResult, type Probe, SETTLED_LANES, type Verdict } from './types'

/**
 * The two roots are NOT the same and conflating them is a false alarm factory.
 * CODE is whatever tree you are standing in (a worktree, when an implementer
 * runs this). The BOARD is gitignored, so it exists only in the main working
 * tree and every worktree must reach back to it.
 */
export interface Roots {
  code: string
  board: string
}

/** Board card lane, or `absent` when the card itself is gone. */
export function cardStatus(root: string, card: string): string {
  const file = join(root, '.rclaude/project/cards', `${card}.md`)
  if (!existsSync(file)) return 'absent'
  const head = readFileSync(file, 'utf8').slice(0, 2000)
  return head.match(/^status:\s*(\S+)/m)?.[1] ?? 'unknown'
}

function matchFiles(root: string, p: Probe): string[] {
  if (p.path.includes('*')) return Array.from(new Glob(p.path).scanSync({ cwd: root, onlyFiles: true }))
  return existsSync(join(root, p.path)) ? [p.path] : []
}

function fileHas(root: string, file: string, needle: string): boolean {
  try {
    return readFileSync(join(root, file), 'utf8').includes(needle)
  } catch {
    return false
  }
}

/** True when the probe's file exists AND (if given) contains its needle. */
export function probeHit(root: string, p: Probe): boolean {
  const files = matchFiles(root, p)
  if (files.length === 0) return false
  const needle = p.needle
  if (!needle) return true
  return files.some(f => fileHas(root, f, needle))
}

const describe = (p: Probe): string => p.as ?? (p.needle ? `${p.needle} in ${p.path}` : p.path)
const probesOf = (a: Aspect): Probe[] => (a.test ? [...a.artifacts, a.test] : [...a.artifacts])
const deadOf = (root: string, ps: Probe[]): Probe[] => ps.filter(p => !probeHit(root, p))

interface Ruling {
  verdict: Verdict
  failures: string[]
}

const ownerLane = (roots: Roots, a: Aspect): string => (a.feedFrom ? cardStatus(roots.board, a.feedFrom) : 'absent')
const beingBuilt = (lane: string): boolean => lane !== 'absent' && !SETTLED_LANES.has(lane)

/** A dead feed with an owner still on it is sequencing; with nobody, a dead end. */
function feedRuling(roots: Roots, aspect: Aspect, deadFeeds: Probe[]): Ruling {
  const lane = ownerLane(roots, aspect)
  const building = beingBuilt(lane)
  const who = building ? `${aspect.feedFrom} is building it (${lane})` : 'NOBODY is building it'
  return {
    verdict: building ? 'BLOCKED' : 'UNDELIVERABLE',
    failures: deadFeeds.map(f => `feed absent, ${who}: ${describe(f)}`),
  }
}

/** With the feeds alive, the only question left is whether the card told the truth. */
function artifactRuling(status: string, dead: Probe[]): Ruling {
  if (!SETTLED_LANES.has(status)) {
    return { verdict: 'PENDING', failures: dead.map(a => `not built yet: ${describe(a)}`) }
  }
  if (dead.length > 0) {
    return { verdict: 'MISSING', failures: dead.map(a => `card is ${status} but absent: ${describe(a)}`) }
  }
  return { verdict: 'VERIFIED', failures: [] }
}

/**
 * Verdict precedence, and the order is the whole design:
 *   1. card gone  -- the quietest way to lose scope
 *   2. feed dead  -- outranks a settled card, so no false PASS over a real gap
 *   3. artifacts  -- did the card tell the truth
 */
function rule(roots: Roots, aspect: Aspect, status: string, deadFeeds: Probe[], deadArtifacts: Probe[]): Ruling {
  if (status === 'absent') return { verdict: 'MISSING', failures: [`card ${aspect.card} is not on the board`] }
  if (deadFeeds.length > 0) return feedRuling(roots, aspect, deadFeeds)
  return artifactRuling(status, deadArtifacts)
}

export function evaluate(roots: Roots, aspect: Aspect): AspectResult {
  const status = cardStatus(roots.board, aspect.card)
  const probes = probesOf(aspect)
  const deadArtifacts = deadOf(roots.code, probes)
  const deadFeeds = deadOf(roots.code, aspect.feeds ?? [])
  const ruling = rule(roots, aspect, status, deadFeeds, deadArtifacts)

  return {
    aspect,
    verdict: ruling.verdict,
    cardStatus: status,
    failures: ruling.failures,
    passed: probes.length - deadArtifacts.length,
    total: probes.length,
  }
}
