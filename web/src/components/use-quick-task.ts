/**
 * Quick Task's state machine -- target project, open/close, text.
 *
 * Split out of `quick-task-modal.tsx` so the component is render-only; the chip
 * set is split again into `use-task-chips` because its lifecycle (seed on open,
 * partial invalidation on a board switch) is its own concern, and the create
 * call into `use-quick-task-filing` because committing a capture is its own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useKnownProjects } from '@/hooks/use-known-projects'
import { useProjectTasksList } from '@/hooks/use-project'
import { useSelectedConversation } from '@/hooks/use-selected-conversation'
import { readEpicFocus } from '@/lib/cards/epic-focus'
import { haptic } from '@/lib/utils'
import { quickTaskBus } from './quick-task-trigger'
import { useQuickTaskFiling } from './use-quick-task-filing'
import { useTaskChips } from './use-task-chips'

export function useQuickTask() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  /** Non-null once `/project` has retargeted this capture. */
  const [overrideProject, setOverrideProject] = useState<string | null>(null)

  const { conversation } = useSelectedConversation()
  const projects = useKnownProjects()
  const { chips, seed, add, drop, keepOnlyPortable, clear } = useTaskChips()

  // The board this capture lands on: an explicit `/project` pick beats the
  // conversation you happen to be sitting in.
  const targetProject = overrideProject ?? conversation?.project ?? null

  // Cards come from the TARGET, so switching project reloads the epic and card
  // pickers too. Completing `@` against the project you just left would offer
  // epic ids that do not exist on the board being written.
  const tasks = useProjectTasksList(targetProject)

  // Opener keybindings + palette command live EAGERLY in use-global-commands.ts
  // (the modal is lazy-mounted, so an opener registered here would be dead until
  // first armed). All open paths -- FAB, palette, Ctrl+Shift+N -- converge here.
  useEffect(() => {
    function handleOpen() {
      haptic('tap')
      // Inherit the epic you are LOOKING at: capturing a thought with an epic
      // open almost always means "this belongs to that". Read on every open
      // rather than held in state, so it can never go stale.
      seed(readEpicFocus())
      setOverrideProject(null)
      setOpen(true)
    }
    quickTaskBus.setHandler(handleOpen)
    return () => quickTaskBus.setHandler(null)
  }, [seed])

  /** Empty the box: text, retarget, chips. Shared by close and by a filed card. */
  const resetCapture = useCallback(() => {
    setText('')
    setOverrideProject(null)
    clear()
  }, [clear])

  // Radix Dialog handles Escape natively; clear on close via onOpenChange.
  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next) resetCapture()
    },
    [resetCapture],
  )

  const onPickProject = useCallback(
    (uri: string) => {
      haptic('tap')
      setOverrideProject(uri)
      keepOnlyPortable()
    },
    [keepOnlyPortable],
  )

  // New object identity per render is fine: the editor reads this through a ref
  // at completion time and never rebuilds its extensions on it.
  const taskTokens = useMemo(
    () => ({ tasks, projects, onPick: add, onPickProject }),
    [tasks, projects, add, onPickProject],
  )

  // Clearing the box is the modal's business, filing the card is not.
  const onFiled = useCallback(() => {
    resetCapture()
    setOpen(false)
  }, [resetCapture])

  const { submit, flash } = useQuickTaskFiling({ text, chips, targetProject, onFiled })

  return {
    open,
    onOpenChange,
    text,
    setText,
    chips,
    onRemoveChip: drop,
    taskTokens,
    submit,
    flash,
    targetProject,
    /** True when the target was chosen explicitly rather than inherited. */
    retargeted: overrideProject != null,
  }
}
