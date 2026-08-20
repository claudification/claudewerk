/**
 * The standing watch, end to end on the producer side.
 *
 * THE BUG THIS EXISTS TO KILL (2026-08-20): the only card-move producer was
 * armed by a refcount of dashboards with the Kanban board OPEN. Close the board
 * -- the normal state, and the state every unattended run is in -- and nothing
 * watched the directory. `card_moves` held 0 rows on a live broker against a
 * card ledger whose every card was marked done.
 *
 * So the headline test moves a card on a REAL directory with no viewer, no
 * dashboard socket and no `project_watch` anywhere in the run, and asserts a
 * `card_changed` comes out. The old code could not have passed it.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardChanged, ProjectChanged, ProjectWatchStatus } from '../shared/protocol'
import { stopAllWatches, watchedRoots } from './project-watch'
import { applyProjectWatchSet, rearmAfterBoardWrite, resetWatchSetReports } from './project-watch-set'

type Out = ProjectChanged | CardChanged | ProjectWatchStatus

const LEASE_MS = 60_000
const roots: string[] = []

/** A project root with a real board on disk. */
function projectWithBoard(...cards: Array<{ id: string; status: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'watch-set-'))
  roots.push(root)
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  for (const c of cards) writeCard(root, c.id, c.status)
  return root
}

function writeCard(root: string, id: string, status: string): void {
  writeFileSync(
    join(root, '.rclaude', 'project', 'cards', `${id}.md`),
    `---\ntitle: "card ${id}"\nstatus: ${status}\npriority: medium\n---\n\nbody\n`,
  )
}

/** A directory that exists but has no board -- the ordinary skip case. */
function projectWithoutBoard(): string {
  const root = mkdtempSync(join(tmpdir(), 'watch-none-'))
  roots.push(root)
  return root
}

function apply(projects: Record<string, string>, out: Out[]) {
  applyProjectWatchSet({
    projects: Object.keys(projects),
    leaseMs: LEASE_MS,
    resolveRoot: uri => {
      const root = projects[uri]
      if (!root) throw new Error(`no such project: ${uri}`)
      return root
    },
    send: msg => out.push(msg),
    log: () => {},
  })
}

afterEach(() => {
  stopAllWatches(() => {})
  resetWatchSetReports()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('applyProjectWatchSet', () => {
  // 20s, not the 5s default: Bun's fs.watch is unreliable on macOS, which is
  // exactly why the watcher carries a 5s poll as its floor. A test bounded at
  // 5s would be racing that floor and would flake on the watcher's bad days
  // rather than on a real regression.
  it('records a lane change with NO dashboard viewer anywhere', async () => {
    const root = projectWithBoard({ id: 'alpha', status: 'open' })
    const out: Out[] = []
    apply({ 'claude://default/alpha': root }, out)

    // Nobody is looking. No project_watch was ever sent. Move the card.
    writeCard(root, 'alpha', 'in-progress')

    const moved = await waitFor(out, m => m.type === 'card_changed')
    expect((moved as CardChanged).moves).toMatchObject([{ id: 'alpha', from: 'open', to: 'in-progress' }])
  }, 20_000)

  it('skips a project with no board, SOFTLY, and keeps watching the others', () => {
    const good = projectWithBoard({ id: 'a', status: 'open' })
    const bare = projectWithoutBoard()
    const out: Out[] = []

    apply({ 'claude://default/good': good, 'claude://default/bare': bare }, out)

    expect(watchedRoots().has(good)).toBe(true)
    expect(watchedRoots().has(bare)).toBe(false)
    expect(out).toContainEqual({
      type: 'project_watch_status',
      project: 'claude://default/bare',
      ok: false,
      reason: 'no-board',
      detail: undefined,
    })
  })

  it('reports an unresolvable URI as a skip rather than throwing the batch away', () => {
    const good = projectWithBoard({ id: 'a', status: 'open' })
    const out: Out[] = []

    applyProjectWatchSet({
      projects: ['claude://default/good', 'claude://broken/x'],
      leaseMs: LEASE_MS,
      resolveRoot: uri => {
        if (uri === 'claude://broken/x') throw new Error('unknown sentinel alias')
        return good
      },
      send: msg => out.push(msg),
      log: () => {},
    })

    expect(watchedRoots().has(good)).toBe(true)
    const skip = out.find(m => m.type === 'project_watch_status' && !m.ok) as ProjectWatchStatus
    expect(skip.reason).toBe('unresolvable')
    expect(skip.detail).toContain('unknown sentinel alias')
  })

  it('tears down a watch for a project that left the set', () => {
    const a = projectWithBoard({ id: 'a', status: 'open' })
    const b = projectWithBoard({ id: 'b', status: 'open' })
    const out: Out[] = []

    apply({ 'claude://default/a': a, 'claude://default/b': b }, out)
    expect(watchedRoots().size).toBe(2)

    apply({ 'claude://default/a': a }, out) // b dropped out of the interest set
    expect(watchedRoots().has(a)).toBe(true)
    expect(watchedRoots().has(b)).toBe(false)
  })

  it('an empty set stops everything', () => {
    const a = projectWithBoard({ id: 'a', status: 'open' })
    const out: Out[] = []
    apply({ 'claude://default/a': a }, out)

    apply({}, out)
    expect(watchedRoots().size).toBe(0)
  })

  it('is idempotent -- re-applying the same set neither restarts nor re-reports', () => {
    const a = projectWithBoard({ id: 'a', status: 'open' })
    const out: Out[] = []

    apply({ 'claude://default/a': a }, out)
    const afterFirst = out.filter(m => m.type === 'project_watch_status').length
    apply({ 'claude://default/a': a }, out)
    apply({ 'claude://default/a': a }, out)

    expect(watchedRoots().size).toBe(1)
    // Change-only reporting: a healthy fleet is silent on the heartbeat.
    expect(out.filter(m => m.type === 'project_watch_status').length).toBe(afterFirst)
  })

  it('picks up a board created AFTER the project first appeared in the set', async () => {
    const root = projectWithoutBoard()
    const out: Out[] = []
    apply({ 'claude://default/late': root }, out)
    expect(watchedRoots().has(root)).toBe(false)

    // The board shows up later; the next heartbeat re-checks rather than
    // caching the first answer forever.
    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    writeCard(root, 'late', 'open')
    apply({ 'claude://default/late': root }, out)

    expect(watchedRoots().has(root)).toBe(true)
    expect(out.filter(m => m.type === 'project_watch_status' && m.ok).length).toBe(1)
  })
})

/**
 * Re-arm on the board write itself.
 *
 * A project with no board is skipped, and the heartbeat re-checks it -- but that
 * is up to 7 minutes. The write that CREATES the board comes through the sentinel
 * (the panel's Kanban UI, the MCP `project_set_status` tool and the board editor
 * all funnel into `project_board_op` / `project_write_file` / `project_move_file`),
 * so the watch can start on the same message instead of waiting for the tick.
 */
describe('rearmAfterBoardWrite', () => {
  it('arms a skipped project the moment its first card is written', () => {
    const root = projectWithoutBoard()
    const out: Out[] = []
    apply({ 'claude://default/fresh': root }, out)
    expect(watchedRoots().has(root)).toBe(false)

    // The board op lands (this is what handleProjectBoardOp would have done).
    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    writeCard(root, 'first', 'inbox')
    rearmAfterBoardWrite(root)

    expect(watchedRoots().has(root)).toBe(true)
    expect(out.filter(m => m.type === 'project_watch_status' && m.ok)).toHaveLength(1)
  })

  it('records the lane change that FOLLOWS the creating write', async () => {
    const root = projectWithoutBoard()
    const out: Out[] = []
    apply({ 'claude://default/fresh': root }, out)

    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    writeCard(root, 'first', 'inbox')
    rearmAfterBoardWrite(root)

    // Without the re-arm this move is simply lost -- that is the whole point.
    writeCard(root, 'first', 'in-progress')
    const moved = await waitFor(out, m => m.type === 'card_changed')
    expect((moved as CardChanged).moves).toMatchObject([{ id: 'first', from: 'inbox', to: 'in-progress' }])
  }, 20_000)

  it('is a no-op for a root the broker never asked about', () => {
    const root = projectWithBoard({ id: 'a', status: 'open' })

    rearmAfterBoardWrite(root) // no set ever mentioned it -- no URI to arm with
    expect(watchedRoots().size).toBe(0)
  })

  it('is a no-op when the write did not actually create a board', () => {
    const root = projectWithoutBoard()
    apply({ 'claude://default/fresh': root }, [])

    rearmAfterBoardWrite(root) // write failed / wrote something else
    expect(watchedRoots().has(root)).toBe(false)
  })

  it('stops re-arming a project that left the set', () => {
    const root = projectWithoutBoard()
    const out: Out[] = []
    apply({ 'claude://default/fresh': root }, out)

    apply({}, out) // dropped out of the interest set

    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    writeCard(root, 'first', 'inbox')
    rearmAfterBoardWrite(root)
    expect(watchedRoots().has(root)).toBe(false)
  })

  it('does not re-arm a project that is already watched', () => {
    const root = projectWithBoard({ id: 'a', status: 'open' })
    const out: Out[] = []
    apply({ 'claude://default/a': root }, out)
    const before = out.filter(m => m.type === 'project_watch_status').length

    rearmAfterBoardWrite(root)
    expect(out.filter(m => m.type === 'project_watch_status').length).toBe(before)
  })
})

/** Poll for a message rather than sleeping a fixed amount: the watcher debounces
 *  300ms and falls back to a 5s poll, so a fixed sleep is either flaky or slow. */
async function waitFor(out: Out[], pred: (m: Out) => boolean, timeoutMs = 15_000): Promise<Out> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = out.find(pred)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for a matching message; got ${out.map(m => m.type).join(', ') || '<none>'}`)
}
