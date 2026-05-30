import { projectIdentityKey } from '@shared/project-uri'
/**
 * In-flight turn decorations -- the live UI that renders at the very bottom of
 * the transcript while a turn is streaming: streaming thinking, streaming text,
 * and the verb spinner. These are pure presentational components driven by the
 * conversation store; they are virtualizer-agnostic, so BOTH transcript
 * renderers (TanStack `TranscriptView` and the react-virtuoso
 * `TranscriptViewVirtuoso` A/B spike) share them.
 *
 * The thinking PILL lives in thinking-pill.tsx and the smooth-collapse motion in
 * collapse.tsx -- both already shared. This module hosts the remaining three.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { Markdown } from '../markdown'
import { Collapse } from './collapse'
import { AssistantText } from './item-renderers'

const EMPTY_STREAMING = ''

/** Thinking block -- renders BEFORE group content (chronological order).
 *  Persists after thinking ends; never cleared during the conversation. */
export const StreamingThinkingBlock = memo(function StreamingThinkingBlock({
  conversationId,
}: {
  conversationId: string | null
}) {
  const isActive = useConversationsStore(state =>
    conversationId ? state.conversationsById[conversationId]?.status === 'active' : false,
  )
  const streamingThinking = useConversationsStore(
    state => (conversationId ? state.streamingThinking[conversationId] : null) || EMPTY_STREAMING,
  )
  if (!streamingThinking) return null
  return (
    <div className="mt-2 pl-4">
      <div className="border-l-2 border-purple-400/40 pl-3 py-1">
        <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1">thinking</div>
        <div className="text-sm opacity-60 italic">
          <Markdown>{streamingThinking}</Markdown>
          {isActive && <span className="inline-block w-1.5 h-4 bg-purple-500 animate-pulse ml-0.5 align-text-bottom" />}
        </div>
      </div>
    </div>
  )
})

/** Streaming text -- renders AFTER group content (response being built). Shares
 *  the committed renderer (AssistantText) so the streaming box IS a dimmed,
 *  emerald-accented version of the final text -- no separate "streaming" header,
 *  identical geometry, so the in-place swap to the committed entry doesn't shift.
 *  The settle morph (border/opacity) lives in the committed group's wrapper. */
export const StreamingTextBlock = memo(function StreamingTextBlock({
  conversationId,
}: {
  conversationId: string | null
}) {
  const showStreaming = useConversationsStore(state => state.controlPanelPrefs.showStreaming !== false)
  const streamingText = useConversationsStore(
    state => (conversationId ? state.streamingText[conversationId] : null) || EMPTY_STREAMING,
  )
  if (!showStreaming || !streamingText) return null
  // pl-4 mirrors GroupView's item container (group-view.tsx) so streaming text
  // sits at the SAME x as the committed assistant text -- no horizontal jump on
  // the settle handoff. The emerald ::before bar bleeds into this pl-4 gutter.
  return (
    <div className="mt-2 pl-4">
      <AssistantText text={streamingText} streaming />
    </div>
  )
})

const VERBS = [
  'Thinking',
  'Reasoning',
  'Pondering',
  'Computing',
  'Processing',
  'Analyzing',
  'Cogitating',
  'Ruminating',
  'Deliberating',
  'Contemplating',
  'Synthesizing',
  'Evaluating',
  'Calculating',
  'Deducing',
  'Inferring',
  'Considering',
  'Brainstorming',
  'Formulating',
  'Assembling',
  'Decoding',
  'Untangling',
  'Composing',
  'Orchestrating',
  'Channeling',
  'Manifesting',
  'Conjuring',
  'Brewing',
  'Crafting',
  'Forging',
  'Weaving',
  'Sculpting',
  'Crunching',
  'Finugeling',
  'Machinating',
  'Scheming',
  'Plotting',
]

/** Shows a fun random verb spinner while the conversation is active (between UserPromptSubmit and Stop) */
export const ThinkingSpinner = memo(function ThinkingSpinner({ conversationId }: { conversationId: string | null }) {
  const isActive = useConversationsStore(state =>
    conversationId ? state.conversationsById[conversationId]?.status === 'active' : false,
  )
  const totalOutput = useConversationsStore(state =>
    conversationId ? (state.conversationsById[conversationId]?.stats?.totalOutputTokens ?? 0) : 0,
  )
  // Custom verbs: project settings override > conversation verbs (from CC settings) > defaults
  const customVerbs = useConversationsStore(state => {
    const conversation = conversationId ? state.conversationsById[conversationId] : undefined
    const projectVerbs = conversation?.project
      ? state.projectSettings[projectIdentityKey(conversation.project)]?.verbs
      : undefined
    return projectVerbs?.length ? projectVerbs : conversation?.spinnerVerbs
  })
  const verbList = customVerbs?.length ? customVerbs : VERBS

  const [verb, setVerb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)])
  const [dots, setDots] = useState(0)
  const baselineRef = useRef(0)

  // Capture baseline when turn starts
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalOutput intentionally omitted - only capture baseline on status transition, not every token update
  useEffect(() => {
    if (isActive) baselineRef.current = totalOutput
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [isActive]) // only on status transition, not on every token update

  const turnTokens = isActive ? Math.max(0, totalOutput - baselineRef.current) : 0

  // biome-ignore lint/correctness/useExhaustiveDependencies: verbList intentionally omitted - stable for conversation duration, re-registering interval on every render unnecessary
  useEffect(() => {
    if (!isActive) return
    const verbInterval = setInterval(() => {
      setVerb(verbList[Math.floor(Math.random() * verbList.length)])
    }, 3000)
    const dotInterval = setInterval(() => {
      setDots(d => (d + 1) % 4)
    }, 400)
    return () => {
      clearInterval(verbInterval)
      clearInterval(dotInterval)
    }
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [isActive])

  // Wrapped in Collapse so it fades/collapses out when the turn ends instead of
  // poofing -- an instant unmount drops scrollHeight and jerks the viewport.
  return (
    <Collapse show={isActive}>
      <div className="mt-2 flex flex-col items-start px-4 py-1.5 text-[11px] font-mono text-muted-foreground/60">
        <div className="flex items-center gap-2">
          <span className="inline-block size-2 bg-accent rounded-full animate-pulse" />
          <span className="text-accent/70">
            {verb}
            {'.'.repeat(dots)}
          </span>
        </div>
        {turnTokens > 0 && (
          <span className="text-muted-foreground/40 tabular-nums pl-4 text-[10px]">
            {(turnTokens / 1000).toFixed(1)}K tokens
          </span>
        )}
      </div>
    </Collapse>
  )
})
