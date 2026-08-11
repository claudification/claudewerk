/**
 * The modal's edit/create view: a draft plus the save round-trip.
 *
 * Split out of `scheduled-tasks-modal.tsx` alongside `browse-pane.tsx`, so the
 * modal file owns only the surface and each pane owns its own state. It also
 * keeps the draft hook out of the modal, where a remount would reset it.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { createScheduledTask, patchScheduledTask } from './api'
import { useScheduledTasksModalStore } from './modal-state'
import { ScheduleEditor } from './schedule-editor'
import { useScheduledTasksStore } from './store'
import { useSaveSchedule } from './use-save-schedule'
import { blankDraft, draftFromTask, draftToCreate, useScheduleDraft } from './use-schedule-draft'

export function EditorPane({ onDone }: { onDone: () => void }) {
  const projectFilter = useScheduledTasksModalStore(s => s.projectFilter)
  const selectedId = useScheduledTasksModalStore(s => s.selectedId)
  const mode = useScheduledTasksModalStore(s => s.mode)
  const tasks = useScheduledTasksStore(s => s.tasks)
  // Opened from the ALL-projects view there is no filter, so fall back to
  // whatever project the panel is already looking at. Without this the form
  // opens with no project AND no directory, and only complains about the
  // directory -- pointing the user at the symptom instead of the cause.
  const selectedProjectUri = useConversationsStore(s => s.selectedProjectUri)

  const existing = mode === 'edit' ? tasks.find(t => t.id === selectedId) : undefined
  const { draft, patch } = useScheduleDraft(
    existing ? draftFromTask(existing) : blankDraft(projectFilter ?? selectedProjectUri ?? ''),
  )

  const { save, saving, error } = useSaveSchedule({
    submit: () =>
      existing ? patchScheduledTask(existing.id, draftToCreate(draft)) : createScheduledTask(draftToCreate(draft)),
    onSaved: onDone,
  })

  return <ScheduleEditor draft={draft} patch={patch} onSave={save} onCancel={onDone} saving={saving} error={error} />
}
