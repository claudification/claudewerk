import type React from 'react'
import { useRef } from 'react'

interface UseComposeOverlayArgs {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setExpanded: (v: boolean) => void
  composeTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearComposeTimers: () => void
}

interface UseComposeOverlayResult {
  composeRetainRef: React.RefObject<number>
  retainCompose: () => void
  releaseCompose: () => void
  handleExpandedFocus: () => void
  handleExpandedBlur: () => void
}

export function useComposeOverlay({
  textareaRef,
  setExpanded,
  composeTimeout,
  clearComposeTimers,
}: UseComposeOverlayArgs): UseComposeOverlayResult {
  const composeRetainRef = useRef(0)

  function retainCompose() {
    composeRetainRef.current++
  }

  function handleExpandedBlur() {
    composeTimeout(() => {
      if (composeRetainRef.current > 0) return
      setExpanded(false)
    }, 200)
  }

  function releaseCompose() {
    composeRetainRef.current = Math.max(0, composeRetainRef.current - 1)
    if (composeRetainRef.current === 0 && document.activeElement !== textareaRef.current) {
      handleExpandedBlur()
    }
  }

  function handleExpandedFocus() {
    composeRetainRef.current = 0
    clearComposeTimers()
  }

  return {
    composeRetainRef,
    retainCompose,
    releaseCompose,
    handleExpandedFocus,
    handleExpandedBlur,
  }
}
