/**
 * The display name a share-link guest shows to the room.
 *
 * Guests have no account, so the name is theirs to pick and lives in
 * localStorage -- remembered across visits and across canvases, never sent
 * anywhere but the presence roster. First-ever visit mints a fun handle
 * ("Snarky Whale") and persists it, so peers see distinct labels instead of a
 * wall of identical "Guest".
 */

import { useCallback, useState } from 'react'
import { generateGuestName } from './guest-name-gen'

const KEY = 'rclaude-canvas-guest-name'

/** Stored name if present, else mint + persist a fresh handle. Falls back to a
 *  volatile generated name when storage is unavailable (private mode). */
function read(): string {
  try {
    const saved = localStorage.getItem(KEY)?.trim()
    if (saved) return saved
    const minted = generateGuestName()
    localStorage.setItem(KEY, minted)
    return minted
  } catch {
    return generateGuestName() // private mode / storage disabled
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
