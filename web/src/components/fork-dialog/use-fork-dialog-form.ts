/**
 * Fork dialog form state + the trigger-bus subscription.
 *
 * Split out of the dialog component so that component stays a renderer. Every
 * field is seeded from the source conversation exactly ONCE, on open: a
 * conversation that goes idle (or starts talking) while the dialog sits there
 * must never re-derive a default under the user's cursor.
 */

import { useCallback, useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { modelPickerValue } from '@/lib/model-picker-value'
import { shortenHomePath } from '@/lib/short-path'
import { type Conversation, type LaunchConfig, projectPath } from '@/lib/types'
import { type ForkDialogOptions, forkDialogBus } from '../fork-dialog-trigger'
import { defaultCloseOriginal } from './close-original'
import type { ForkDirection, ForkPointSeed } from './fork-point'
import type { ForkStrategy } from './fork-strategy'

export interface ForkForm {
  strategy: ForkStrategy
  name: string
  model: string
  effort: string
  cwd: string
  worktree: string
  /** Kill the SOURCE once the fork is up -- see `close-original.ts` for why it
   *  arrives pre-ticked for a conversation nobody has touched in 30 minutes. */
  closeOriginal: boolean
  /** Point-in-time only; ignored when the dialog was opened without a boundary. */
  direction: ForkDirection
  includeBoundary: boolean
  summarizeDropped: boolean
}

const EMPTY_FORM: ForkForm = {
  strategy: 'compacted',
  name: '',
  model: '',
  effort: '',
  cwd: '',
  worktree: '',
  closeOriginal: false,
  // `before` + inclusive is the read most people have in mind when they point at
  // a message: everything up to and including this. Summarizing is off because it
  // costs a model call and silently rewrites history.
  direction: 'before',
  includeBoundary: true,
  summarizeDropped: false,
}

function initialForm(source: Conversation | undefined): ForkForm {
  if (!source) return EMPTY_FORM
  const launch: Partial<LaunchConfig> = source.launchConfig ?? {}
  return {
    ...EMPTY_FORM,
    strategy: 'compacted',
    name: source.title ? `${source.title} (fork)` : '',
    // A fork should default to whatever the conversation actually ran with.
    // launchConfig holds spawn-option values; `conversation.model` is the
    // RUNTIME id CC reported (`claude-opus-4-8[1m]`) and matches no option in
    // the picker -- feeding that in raw is what left Model rendering blank next
    // to Effort's "Default". modelPickerValue maps it onto a real option.
    model: modelPickerValue(launch.model || source.model),
    // effortLevel is the RUNTIME value (CC can switch effort mid-session), so it
    // reflects what the conversation was actually running at.
    effort: launch.effort || source.effortLevel || '',
    // Home-relative for display; the sentinel's expandPath resolves `~/` (and
    // project URIs, and relative paths) on the way back in.
    cwd: shortenHomePath(projectPath(source.project)),
    worktree: '',
    closeOriginal: defaultCloseOriginal(source),
  }
}

export interface ForkDialogForm {
  open: boolean
  /** Bumped on every open. The caller keys its fork-action reset off this --
   *  the hook cannot own that reset because the fork action is built FROM the
   *  conversation this hook resolves. */
  openId: number
  conversation: Conversation | undefined
  /** The entry the fork was started from, when it was started from one. */
  forkPoint: ForkPointSeed | undefined
  form: ForkForm
  patch: (patch: Partial<ForkForm>) => void
  close: () => void
}

export function useForkDialogForm(): ForkDialogForm {
  const [options, setOptions] = useState<ForkDialogOptions | null>(null)
  const [openId, setOpenId] = useState(0)
  const [form, setForm] = useState<ForkForm>(EMPTY_FORM)

  const conversationsById = useConversationsStore(s => s.conversationsById)
  const conversation = options ? conversationsById[options.conversationId] : undefined

  useEffect(() => {
    forkDialogBus.setHandler((next: ForkDialogOptions) => {
      setForm(initialForm(useConversationsStore.getState().conversationsById[next.conversationId]))
      setOptions(next)
      setOpenId(n => n + 1)
    })
    return () => forkDialogBus.setHandler(null)
  }, [])

  const close = useCallback(() => setOptions(null), [])
  const patch = useCallback((p: Partial<ForkForm>) => setForm(f => ({ ...f, ...p })), [])

  return { open: options !== null, openId, conversation, forkPoint: options?.forkPoint, form, patch, close }
}
