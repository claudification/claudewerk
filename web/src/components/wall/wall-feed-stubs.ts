/**
 * The thinnest legal body for every HTTP feed THE WALL pulls.
 *
 * A resilience suite mounts the WHOLE surface, so every pull-fed pane fires its
 * real request. What is IN the response is each pane card's own business; these
 * suites only care whether it was ASKED FOR and when. But "thin" is not "empty":
 * A6 hands the sheaf response straight to `summarizeSheaf`, which reads
 * `.projects` and `.totals`, so a bare `[]` takes the pane down and the failure
 * looks like a resilience bug rather than a bad stub.
 *
 * Shared by `wall-revive.test.tsx` and `wall-history-gap.test.tsx`. Kept out of
 * `wall-test-utils.tsx` on purpose: that rig is what every wall suite in this
 * epic imports, and a file twelve parallel worktrees touch is a merge conflict
 * waiting to happen.
 */

import { vi } from 'vitest'

function bodyFor(url: string): unknown {
  if (url.includes('/api/stats/tokens')) return { buckets: [] }
  if (url.includes('/api/stats/openrouter')) return { byFeature: [] }
  if (url.includes('/api/stats/summary')) return { totalCostUsd: 0 }
  if (url.includes('/api/commits/feed')) {
    return { commits: [], conversations: [], projects: [], cursor: null, hasMore: false }
  }
  if (url.includes('/api/sheaf')) {
    return {
      windowH: 24,
      windowStart: 0,
      windowEnd: 1,
      generatedAt: 1,
      totals: {
        projects: 0,
        conversations: 0,
        trees: 0,
        tokens: { input: 0, output: 0, cache: 0 },
        cost: { amount: 0, estimated: false },
      },
      projects: [],
    }
  }
  // `/api/stats/hourly` and anything else the wall grows: a row list.
  return []
}

/**
 * Answer every wall feed.
 *
 * @param isUp  read fresh on each request, so a suite can take the broker away
 *   mid-test and watch the surface mark what it can no longer verify.
 */
export function stubWallHttp(isUp: () => boolean = () => true): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (!isUp()) throw new Error('broker is down')
    return new Response(JSON.stringify(bodyFor(String(input))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}
