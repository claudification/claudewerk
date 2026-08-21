/**
 * Filing a capture: draft -> board op -> the "Task created" flash.
 *
 * Split from `use-quick-task` at the seam between what the modal HOLDS (target
 * project, text, chips, open) and what happens when you COMMIT it.
 */

import { useCallback, useState } from 'react'
import { sendBoardOp } from '@/hooks/use-project-tasks'
import { buildTaskDraft, type TaskChips } from '@/lib/cards/task-chips'
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

  const submit = useCallback(() => {
    const draft = buildTaskDraft(text, chips)
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
  }, [text, chips, targetProject, onFiled])

  return { submit, flash }
}
