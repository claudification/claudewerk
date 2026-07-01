import { useEffect, useState } from 'react'
import { fetchSubagentTranscript, useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptEntry } from '@/lib/types'

const EMPTY_TRANSCRIPT: TranscriptEntry[] = []

export function useSubagentFetch(selectedConversationId: string | null) {
  const selectedSubagentId = useConversationsStore(state => state.selectedSubagentId)
  const selectSubagent = useConversationsStore(state => state.selectSubagent)

  const subagentKey =
    selectedConversationId && selectedSubagentId ? `${selectedConversationId}:${selectedSubagentId}` : ''
  const subagentTranscriptRaw = useConversationsStore(state =>
    subagentKey ? state.subagentTranscripts[subagentKey] : undefined,
  )
  const subagentTranscript = subagentTranscriptRaw || EMPTY_TRANSCRIPT

  const [subagentLoading, setSubagentLoading] = useState(false)

  // react-doctor-disable-next-line react-doctor/no-derived-state -- multi-source: loading set synchronously on key change AND cleared by async fetch
  const [prevSubagentKey, setPrevSubagentKey] = useState(subagentKey)
  if (subagentKey !== prevSubagentKey) {
    setPrevSubagentKey(subagentKey)
    if (subagentKey) setSubagentLoading(true)
  }

  useEffect(() => {
    if (!selectedConversationId || !selectedSubagentId) return
    let cancelled = false
    fetchSubagentTranscript(selectedConversationId, selectedSubagentId).then(entries => {
      if (cancelled) return
      setSubagentLoading(false)
      if (entries.length > 0) {
        const key = `${selectedConversationId}:${selectedSubagentId}`
        useConversationsStore.setState(state => ({
          subagentTranscripts: { ...state.subagentTranscripts, [key]: entries },
        }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedConversationId, selectedSubagentId])

  return { selectedSubagentId, selectSubagent, subagentTranscript, subagentLoading }
}
