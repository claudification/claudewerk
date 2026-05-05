import type React from 'react'
import { useRef, useState } from 'react'
import { haptic } from '@/lib/utils'

interface UseVoiceInputArgs {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  showVoice: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setExpanded: (v: boolean) => void
  composeTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  composeTimersRef: React.RefObject<Set<ReturnType<typeof setTimeout>>>
}

interface UseVoiceInputResult {
  showVoiceOverlay: boolean
  holdToRecord: boolean
  setShowVoiceOverlay: (v: boolean) => void
  micPermissionRef: React.RefObject<boolean>
  handleVoiceResult: (text: string) => void
  handleVoiceResultAndSubmit: (text: string) => void
  handleVoiceClose: () => void
  handleSendPointerDown: () => void
  handleSendPointerUp: () => void
}

export function useVoiceInput({
  value,
  onChange,
  onSubmit,
  showVoice,
  textareaRef,
  setExpanded,
  composeTimeout,
  composeTimersRef,
}: UseVoiceInputArgs): UseVoiceInputResult {
  const [showVoiceOverlay, setShowVoiceOverlay] = useState(false)
  const [holdToRecord, setHoldToRecord] = useState(false)
  const holdActiveRef = useRef(false)
  const micPermissionRef = useRef(false)
  const holdTimerIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleVoiceResult(text: string) {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? value.length
    const before = value.slice(0, pos)
    const after = value.slice(pos)
    const spacer = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
    onChange(`${before + spacer}voice-to-text: ${text}${after}`)
    ta?.focus()
  }

  function handleVoiceResultAndSubmit(text: string) {
    handleVoiceResult(text)
    if (holdToRecord) {
      setTimeout(() => {
        onSubmit()
        setExpanded(false)
        setHoldToRecord(false)
      }, 50)
    }
  }

  function handleVoiceClose() {
    setShowVoiceOverlay(false)
    setHoldToRecord(false)
    holdActiveRef.current = false
  }

  function handleSendPointerDown() {
    if (value.trim() || !showVoice) return
    if (!micPermissionRef.current) {
      holdTimerIdRef.current = composeTimeout(() => {
        holdTimerIdRef.current = null
        setHoldToRecord(false)
        setShowVoiceOverlay(true)
      }, 300)
      return
    }
    holdTimerIdRef.current = composeTimeout(() => {
      holdTimerIdRef.current = null
      holdActiveRef.current = true
      setHoldToRecord(true)
      setShowVoiceOverlay(true)
      haptic('double')
    }, 300)
  }

  function handleSendPointerUp() {
    if (holdTimerIdRef.current) {
      clearTimeout(holdTimerIdRef.current)
      composeTimersRef.current.delete(holdTimerIdRef.current)
      holdTimerIdRef.current = null
    }
    if (holdActiveRef.current) holdActiveRef.current = false
  }

  return {
    showVoiceOverlay,
    holdToRecord,
    setShowVoiceOverlay,
    micPermissionRef,
    handleVoiceResult,
    handleVoiceResultAndSubmit,
    handleVoiceClose,
    handleSendPointerDown,
    handleSendPointerUp,
  }
}
