import { projectIdentityKey } from '@shared/project-uri'
import { useMemo } from 'react'
import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { extractProjectLabel } from '@/lib/types'
import { SELECT_CLS } from './settings-item'

export function DefaultConversationPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const conversations = useConversations()
  const projectSettings = useConversationsStore(s => s.projectSettings)
  // Unique projects by project URI
  const options = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of conversations) {
      if (s.project && !seen.has(s.project)) {
        seen.set(
          s.project,
          projectSettings[projectIdentityKey(s.project)]?.label || extractProjectLabel(s.project) || s.project,
        )
      }
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [conversations, projectSettings])

  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={`${SELECT_CLS} w-44`}>
      <option value="">None</option>
      {options.map(([uri, label]) => (
        <option key={uri} value={uri}>
          {label}
        </option>
      ))}
    </select>
  )
}
