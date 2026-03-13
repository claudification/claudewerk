/**
 * TranscriptView - Virtualized transcript renderer.
 * Uses @tanstack/react-virtual for efficient rendering of large transcript streams.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useRef } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { TranscriptEntry } from '@/lib/types'
import { CompactedDivider, CompactingBanner, GroupView } from './group-view'
import { useIncrementalGroups } from './grouping'

interface TranscriptViewProps {
  entries: TranscriptEntry[]
  follow?: boolean
  showThinking?: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
}

export function TranscriptView({
  entries,
  follow = false,
  showThinking = false,
  onUserScroll,
  onReachedBottom,
}: TranscriptViewProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const followKilledRef = useRef(false)

  const { resultMap, groups } = useIncrementalGroups(entries)

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150,
    overscan: 5,
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement
      if (!el) return
      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry) {
          requestAnimationFrame(() => {
            cb({ width: entry.contentRect.width, height: entry.contentRect.height })
          })
        }
      })
      observer.observe(el)
      return () => observer.disconnect()
    },
  })

  useEffect(() => {
    if (follow) followKilledRef.current = false
  }, [follow])

  const killFollow = useCallback(
    (e: React.WheelEvent | React.TouchEvent) => {
      if (!follow) return
      if ('deltaY' in e && e.deltaY >= 0) return
      followKilledRef.current = true
      onUserScroll?.()
    },
    [follow, onUserScroll],
  )

  useEffect(() => {
    const el = parentRef.current
    if (!el || follow) return
    function handleScroll() {
      if (!el) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      if (atBottom) onReachedBottom?.()
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [follow, onReachedBottom])

  const newDataSeq = useSessionsStore(state => state.newDataSeq)

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current
    if (!el || followKilledRef.current) return
    let lastHeight = -1
    let retries = 0
    function settle() {
      if (!el || followKilledRef.current) return
      el.scrollTop = el.scrollHeight
      if (el.scrollHeight !== lastHeight && retries < 10) {
        lastHeight = el.scrollHeight
        retries++
        requestAnimationFrame(settle)
      }
    }
    requestAnimationFrame(settle)
  }, [])

  useEffect(() => {
    if (!follow || followKilledRef.current) return
    scrollToBottom()
  }, [follow, newDataSeq, scrollToBottom])

  useEffect(() => {
    if (!follow) return
    scrollToBottom()
  }, [follow, entries.length, scrollToBottom])

  if (groups.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10 font-mono">
        <pre className="text-xs">
          {`
┌─────────────────────────┐
│   [ NO TRANSCRIPT ]     │
│   Waiting for data...   │
└─────────────────────────┘
`.trim()}
        </pre>
      </div>
    )
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto p-3 sm:p-4" onWheel={killFollow} onTouchStart={killFollow}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualItem => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {(() => {
              const group = groups[virtualItem.index]
              if (group.type === 'compacted') return <CompactedDivider />
              if (group.type === 'compacting') return <CompactingBanner />
              return <GroupView group={group} resultMap={resultMap} showThinking={showThinking} />
            })()}
          </div>
        ))}
      </div>
    </div>
  )
}
