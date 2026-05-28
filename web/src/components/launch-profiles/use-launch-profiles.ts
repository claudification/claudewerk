import type { LaunchProfile } from '@shared/launch-profile'
import { useCallback, useEffect, useState } from 'react'
import { fetchLaunchProfiles, putLaunchProfiles, type SaveProfilesResponse } from './api'
import {
  getLaunchProfilesSnapshot,
  isLaunchProfilesLoading,
  setLaunchProfiles,
  setLaunchProfilesLoading,
  subscribeLaunchProfiles,
} from './store'

export interface UseLaunchProfilesResult {
  profiles: LaunchProfile[]
  loaded: boolean
  loading: boolean
  reload: () => Promise<void>
  save: (next: LaunchProfile[]) => Promise<SaveProfilesResponse>
}

/**
 * Stable reference for the "not loaded yet" case. Returning a fresh `[]`
 * on every render churns referential equality and breaks effects that
 * depend on `profiles` (e.g. the manager's draft-seeding effect, which
 * would otherwise wipe a freshly-created profile on the next render).
 */
const EMPTY_PROFILES: LaunchProfile[] = []

async function ensureLaunchProfilesLoaded(): Promise<LaunchProfile[]> {
  if (getLaunchProfilesSnapshot() !== null) return getLaunchProfilesSnapshot() as LaunchProfile[]
  if (isLaunchProfilesLoading()) {
    return new Promise(resolve => {
      const unsub = subscribeLaunchProfiles(p => {
        if (p !== null) {
          unsub()
          resolve(p)
        }
      })
    })
  }
  setLaunchProfilesLoading(true)
  try {
    const profiles = await fetchLaunchProfiles()
    setLaunchProfiles(profiles)
    return profiles
  } finally {
    setLaunchProfilesLoading(false)
  }
}

export function useLaunchProfiles(): UseLaunchProfilesResult {
  const [snapshot, setSnapshot] = useState<LaunchProfile[] | null>(getLaunchProfilesSnapshot())

  useEffect(() => subscribeLaunchProfiles(setSnapshot), [])

  useEffect(() => {
    if (snapshot === null && !isLaunchProfilesLoading()) {
      void ensureLaunchProfilesLoaded()
    }
  }, [snapshot])

  const reload = useCallback(async () => {
    const profiles = await fetchLaunchProfiles()
    setLaunchProfiles(profiles)
  }, [])

  const save = useCallback(async (next: LaunchProfile[]) => {
    const res = await putLaunchProfiles(next)
    if (res.ok && res.profiles) setLaunchProfiles(res.profiles)
    return res
  }, [])

  return {
    profiles: snapshot ?? EMPTY_PROFILES,
    loaded: snapshot !== null,
    loading: isLaunchProfilesLoading(),
    reload,
    save,
  }
}

export function handleLaunchProfilesUpdatedMessage(profiles: LaunchProfile[]): void {
  setLaunchProfiles(profiles)
}
