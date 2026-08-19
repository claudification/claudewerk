/**
 * Regression: a palette entry must not be listed to a user for whom the thing
 * it opens never mounts.
 *
 * `app.tsx` mounts the wall as `{canAdmin && <WallModal />}`. The `wall` command
 * originally carried no `when`, and `getCommands()` only filters on `when` -- so
 * a non-admin saw "THE WALL" in Cmd+P, picked it, and nothing happened.
 * `openWall()` wrote the modal record into a store nobody was rendering.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useGlobalCommands } from '@/hooks/use-global-commands'
import { getCommands } from '@/lib/commands'
import { DEFAULT_PERMISSIONS } from '@/lib/permissions'

function Host() {
  useGlobalCommands(() => {})
  return null
}

function paletteIds(canAdmin: boolean): string[] {
  useConversationsStore.setState({ permissions: { ...DEFAULT_PERMISSIONS, canAdmin } })
  render(<Host />)
  return getCommands().map(c => c.id)
}

afterEach(cleanup)

describe('the admin-gated System commands', () => {
  it('hides THE WALL from a user who cannot mount it', () => {
    expect(paletteIds(false)).not.toContain('wall')
  })

  it('lists THE WALL for an admin, next to its gated siblings', () => {
    const ids = paletteIds(true)

    expect(ids).toContain('wall')
    // The siblings whose gate the wall was copied from -- if these ever stop
    // being admin-only this test is asserting the wrong invariant.
    expect(ids).toContain('manage-sentinels')
  })
})
