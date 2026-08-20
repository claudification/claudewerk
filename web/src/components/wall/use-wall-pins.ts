/**
 * `useWallPins()` -- every pinned epic the fleet has, across every project.
 *
 * THE FEED IS THE BOARD ITSELF. The pin is `wall_pinned: true` in an epic card's
 * frontmatter (src/shared/wall-pin.ts), so a pin written by an agent with a text
 * editor shows up here on the next poll. No panel-side preference store, and no
 * second source of truth about what you are watching.
 *
 * THE FOLD RUNS ON THE SENTINEL. `pinnedEpicRows` needs the FULL card -- only it
 * carries the pin -- so folding in the browser meant hydrating every project's
 * whole board into the shared cache to find a handful of booleans, once per
 * project. The `pinned` board op runs the identical fold beside the files and
 * returns only the rows: one small round trip per project, and the wall no
 * longer touches the board cache at all.
 *
 * WHY IT POLLS. `project_changed` only arrives for a project some MOUNTED board
 * is watching, and the wall deliberately arms no watches of its own -- a dozen
 * lease-bound sentinel watches because a wall is open is worse than a slow tick.
 * So the pane re-asks on a slow clock, which is also what makes it live for the
 * ordinary case where no board is open anywhere.
 */

import type { PinnedEpicRow } from '@shared/pinned-epic-rows'
import { projectIdentityKey } from '@shared/project-uri'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { installSharedHandler } from '@/hooks/project-task-cache'
import { sendBoardOp } from '@/hooks/project-task-wire'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectDisplayName } from '@/lib/utils'
import { useWallRevive } from '@/lib/wall/use-wall-revive'

/** A pinned epic, plus how its project is meant to LOOK (the configured icon and
 *  colour, resolved once here rather than per row). */
export interface WallPinRow extends PinnedEpicRow {
  projectName: string
  projectIcon?: string
  projectColor?: string
}

/**
 * How often the watchlist re-asks. Epic progress is measured in cards landing,
 * not in frames -- a minute of lag would be invisible, and this is already far
 * inside that. It is one small op per project, and the fold it triggers is a
 * local directory read the board watcher already does on every change.
 */
const PIN_POLL_MS = 15_000

/** Projects with a `pinned` op in flight -- a slow sentinel must not stack up a
 *  second ask on the next tick. */
const inflight = new Set<string>()

/**
 * The projects the panel knows about, from the conversation registry -- the same
 * source Pulse and the board use. A project the panel has never seen a
 * conversation for is invisible to the whole wall, not just to this pane.
 *
 * Returned JOINED, because the joined string is the real identity: the array is
 * rebuilt on every store churn, and an effect keyed on the array would refetch
 * the whole fleet every time a conversation so much as blinked.
 */
function useKnownProjectKey(): string {
  const conversationsById = useConversationsStore(s => s.conversationsById)
  return useMemo(() => {
    const seen = new Set<string>()
    for (const conv of Object.values(conversationsById)) {
      if (conv.project) seen.add(conv.project)
    }
    return [...seen].sort().join('\n')
  }, [conversationsById])
}

/** One project's rows, or null when the ask failed -- a timeout leaves the last
 *  known watchlist standing rather than blanking it. */
async function fetchPins(projectUri: string): Promise<PinnedEpicRow[] | null> {
  if (inflight.has(projectUri)) return null
  inflight.add(projectUri)
  try {
    const resp = await sendBoardOp(projectUri, 'pinned')
    return (resp.pinned as PinnedEpicRow[] | undefined) ?? []
  } catch {
    // Disconnected, or a sentinel that predates the op. Either way: keep what we
    // have and ask again on the next tick.
    return null
  } finally {
    inflight.delete(projectUri)
  }
}

export interface WallPinFeed {
  rows: WallPinRow[]
  /** The watchlist on screen was last answered on an earlier connection. */
  stale: boolean
}

export function useWallPins(): WallPinFeed {
  const projectKey = useKnownProjectKey()
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const [rowsByProject, setRowsByProject] = useState<Record<string, PinnedEpicRow[]>>({})

  // The one shared project handler routes every `project_board_result` back to
  // its promise. The board installs it too; whoever gets there first wins.
  useEffect(() => {
    installSharedHandler()
  }, [])

  // A reply is stale only once the pane is GONE. Scoping the guard to the effect
  // RUN instead would throw away an answer that outlived its own tick -- and with
  // the in-flight guard above skipping the next ask, a project slower than the
  // poll would then never land at all.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Ask every known project at once. Resolves TRUE when at least one answered:
   * one unreachable sentinel among six is a partial watchlist, not a dead one.
   *
   * The poll clock this hook used to run off `useWallClock` is the seam's now, so
   * the same call heals a reconnect and drives the ordinary tick. A board op over
   * a socket that just came back is exactly the read that used to fail silently
   * and then wait fifteen seconds.
   */
  const load = useCallback(async () => {
    const projects = projectKey ? projectKey.split('\n') : []
    if (projects.length === 0) return false
    const answers = await Promise.all(
      projects.map(async projectUri => {
        const rows = await fetchPins(projectUri)
        if (rows && mounted.current) setRowsByProject(prev => ({ ...prev, [projectUri]: rows }))
        return rows !== null
      }),
    )
    return answers.some(Boolean)
  }, [projectKey])

  const { stale } = useWallRevive('pins', load, PIN_POLL_MS)

  // The project list changing is a new QUESTION, not a stale answer: a project
  // the panel has just learned about has never been asked at all.
  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => {
    const rows: WallPinRow[] = []
    // Driven by the CURRENT project list, so a project that left the registry
    // stops rendering without anyone having to prune the map behind it.
    for (const projectUri of projectKey ? projectKey.split('\n') : []) {
      const settings = projectSettings[projectIdentityKey(projectUri)]
      for (const row of rowsByProject[projectUri] ?? []) {
        rows.push({
          ...row,
          // The sentinel stamps this from the URI we sent it; re-stamping keeps a
          // row addressable even against a sentinel that did not.
          project: projectUri,
          projectName: projectDisplayName(projectUri, settings?.label),
          projectIcon: settings?.icon,
          projectColor: settings?.color,
        })
      }
    }
    return rows.toSorted((a, b) => b.movedAt - a.movedAt)
  }, [projectKey, projectSettings, rowsByProject])

  return useMemo(() => ({ rows, stale }), [rows, stale])
}
