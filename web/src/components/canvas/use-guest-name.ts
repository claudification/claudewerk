/**
 * The display name a share-link guest shows to the room.
 *
 * Guests have no account, so the name is theirs to pick and lives in
 * localStorage -- remembered across visits and across canvases, never sent
 * anywhere but the presence roster.
 */

import { useCallback, useState } from 'react'

const KEY = 'rclaude-canvas-guest-name'
const FALLBACK = 'Guest'

function read(): string {
  try {
    return localStorage.getItem(KEY)?.trim() || FALLBACK
  } catch {
    return FALLBACK // private mode / storage disabled
  }
}

export function useGuestName(): { name: string; rename: () => void } {
  const [name, setName] = useState(read)

  const rename = useCallback(() => {
    const next = window.prompt('Your name on this canvas', name)?.trim()
    if (!next) return
    setName(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {}
  }, [name])

  return { name, rename }
}
