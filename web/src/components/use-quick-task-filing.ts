/**
 * Filing a capture: draft -> board op -> the "Task created" flash.
 *
 * Split from `use-quick-task` at the seam between what the modal HOLDS (target
 * project, text, chips, open) and what happens when you COMMIT it. The two
 * submit keys live here together on purpose: they differ by one tag, and two
 * copies of the create call is how they drift apart.
 */

import { useCallback, useState } from 'react'
import { sendBoardOp } from '@/hooks/use-project-tasks'
import { buildTaskDraft, NEEDS_REFINE_TAG, type TaskChips } from '@/lib/cards/task-chips'
import { haptic } from '@/lib/utils'

interface FilingArgs {
  text: string
  chips: TaskChips
  targetProject: string | null
  /** Reset the capture box. Called ONLY when a card actually went out. */
  onFiled: () => void
}

export function useQuickTaskFiling({ text, chips, targetProject, onFiled }: FilingArgs) {
  const [flash, setFlash] = useState(false)

  const fileCard = useCallback(
    (extraTags: string[]) => {
      const draft = buildTaskDraft(text, chips, extraTags)
      if (!draft || !targetProject) return
      haptic('tap')

      // Logged for recovery in case the WS relay drops it on the floor.
      console.log('[quick-task] Creating task:', JSON.stringify({ ...draft, project: targetProject }))
      sendBoardOp(targetProject, 'create', { input: draft }).catch(err => {
        console.error('[quick-task] Failed to create task:', err, draft)
      })

      haptic('success')
      onFiled()
      setFlash(true)
      setTimeout(() => setFlash(false), 1000)
    },
    [text, chips, targetProject, onFiled],
  )

  /** Enter / the Add button: file the card as captured. */
  const submit = useCallback(() => fileCard([]), [fileCard])

  /** Mod-Enter: the same card, tagged for a later pass. No spawn, no queue. */
  const submitRefine = useCallback(() => fileCard([NEEDS_REFINE_TAG]), [fileCard])

  return { submit, submitRefine, flash }
}
