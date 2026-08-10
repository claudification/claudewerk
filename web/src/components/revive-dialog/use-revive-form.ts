/**
 * Every field the revive dialog edits, in one place.
 *
 * Mode / model / effort are SHARED across both tabs on purpose: they mean the
 * same thing whether the conversation is resumed or forked, and splitting them
 * per-tab would silently drop a choice the moment you switched.
 */

import { useCallback, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { modelPickerValue } from '@/lib/model-picker-value'
import { shortenHomePath } from '@/lib/short-path'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import type { LaunchFieldsValue } from '../launch-config-fields'
import type { ForkTabValue } from './fork-tab'
import { computeReviveDefaults } from './revive-defaults'

export type ReviveTab = 'revive' | 'fork'

/** What the FORK tab opens with: a named copy, rooted where the source ran. */
function forkDefaults(sess: Conversation | undefined): ForkTabValue {
  return {
    strategy: 'compacted',
    name: sess?.title ? `${sess.title} (fork)` : '',
    // Home-relative for display; the sentinel's expandPath resolves `~/` (and
    // project URIs, and relative paths) on the way back in.
    cwd: sess ? shortenHomePath(projectPath(sess.project)) : '',
    worktree: '',
  }
}

export function useReviveForm() {
  const [tab, setTab] = useState<ReviveTab>('revive')
  const [headless, setHeadless] = useState(true)
  const [fields, setFields] = useState<LaunchFieldsValue>({ model: '', effort: '' })
  const [profile, setProfile] = useState('')
  const [forkValue, setForkValue] = useState<ForkTabValue>(forkDefaults(undefined))

  /** Reload every field from the conversation + the settings resolution chain. */
  const resetFrom = useCallback((conversationId: string) => {
    const store = useConversationsStore.getState()
    const sess = store.conversationsById[conversationId]
    const defaults = computeReviveDefaults({
      conversation: sess,
      projectSettings: store.projectSettings,
      globalSettings: store.globalSettings,
      sentinels: store.sentinels,
      profileUsage: store.profileUsage,
    })

    setTab('revive')
    setHeadless(defaults.headless)
    // `conversation.model` is the RUNTIME id CC reported and matches no option
    // in the picker, so it goes through modelPickerValue on the way in.
    setFields({ model: modelPickerValue(defaults.model || sess?.model), effort: defaults.effort })
    setProfile(defaults.profile)
    setForkValue(forkDefaults(sess))
  }, [])

  const applyFields = useCallback((patch: Partial<LaunchFieldsValue>) => {
    setFields(prev => ({ ...prev, ...patch }))
  }, [])

  const patchFork = useCallback((patch: Partial<ForkTabValue>) => {
    setForkValue(prev => ({ ...prev, ...patch }))
  }, [])

  return {
    tab,
    setTab,
    headless,
    setHeadless,
    model: fields.model ?? '',
    effort: fields.effort ?? '',
    fields,
    applyFields,
    profile,
    setProfile,
    forkValue,
    patchFork,
    resetFrom,
  }
}

export type UseReviveForm = ReturnType<typeof useReviveForm>
