import { cn } from '@/lib/utils'
import { CopyMenu } from '../copy-menu'
import { JsonInspector } from '../json-inspector'
import { Markdown } from '../markdown'
import { AgentTranscriptInline } from './agent-views'
import type { RenderItem } from './group-view-types'
import { MemoizedToolLine } from './tool-line'
import { BashOutput } from './tool-renderers'

export { ChannelItem } from './channel-renderers'

// Module-level so the function reference is stable across renders -- otherwise
// MemoizedToolLine's default shallow compare misses on every parent re-render
// (e.g. a streaming tail-append re-rendering the last group), and every tool
// block in that group does the dispatchToolCase work over again.
const renderAgentInline = (agentId: string, toolId?: string) => (
  <AgentTranscriptInline agentId={agentId} toolId={toolId} />
)

// Encrypted thinking blocks are SEALED, COMPLETED thoughts -- the content never
// lands in the transcript, only its size. The live spinner is present-tense
// ("Thinking..."), so the committed ghost reads in PAST tense: what the model
// already DID. Random (but per-block stable) wild past-tense synonym.
const THOUGHTS = [
  'THOUGHT',
  'PONDERED',
  'MUSED',
  'RUMINATED',
  'COGITATED',
  'NOODLED',
  'BRAINSTORMED',
  'MULLED IT OVER',
  'DELIBERATED',
  'CONTEMPLATED',
  'OVERTHOUGHT',
  'THUNK',
  'DEEP THUNK',
  'GALAXY-BRAINED',
  'BIG THONK',
  'OVERCLOCKED',
  'HALLUCINATED',
  'VIBED',
  'COOKED',
  'LOCKED IN',
  'SPIRALED',
  'WOOLGATHERED',
  'CEREBRATED',
  'SCHEMED',
  'COMPUTED',
  '5D-CHESSED',
  'INTROSPECTED',
  'SECOND-GUESSED',
]
// Deterministic per-block pick so a given block always shows the same word --
// no flicker, no Math.random. Seed is stable content: the thinking text for
// readable blocks, the encrypted byte size for sealed ones.
function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') return seed | 0
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return h
}
function thoughtFor(seed: string | number): string {
  let h = hashSeed(seed) | 0
  h = (h * 2654435761) | 0
  return THOUGHTS[Math.abs(h) % THOUGHTS.length]
}

export function ThinkingItem({ item }: { item: Extract<RenderItem, { kind: 'thinking' }> }) {
  const isEncrypted = !item.text && typeof item.encryptedBytes === 'number'
  const estBytes = isEncrypted ? Math.round((item.encryptedBytes as number) * 0.75) : 0

  return (
    <div className="border-l-2 border-purple-400/40 pl-3 py-1">
      <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider flex items-center gap-1.5">
        {/* Committed thinking is a COMPLETED thought -> past-tense synonym (the
            live StreamingThinkingBlock still says "thinking"). Seeded on stable
            content so it never flickers. */}
        <span>{thoughtFor(isEncrypted ? (item.encryptedBytes as number) : item.text)}</span>
        {isEncrypted && (
          <>
            <span className="text-purple-400/40 normal-case font-normal tracking-normal">encrypted, ~{estBytes}b</span>
            {item.rawBlock && (
              <JsonInspector
                title="encrypted thinking block"
                data={item.rawBlock as unknown as Record<string, unknown>}
                raw={item.rawBlock}
              />
            )}
          </>
        )}
      </div>
      {!isEncrypted && (
        <div className="text-sm opacity-75">
          <Markdown>{item.text}</Markdown>
        </div>
      )}
    </div>
  )
}

const PRIO_COLORS: Record<string, string> = {
  high: 'border-l-red-500',
  medium: 'border-l-amber-500',
  low: 'border-l-blue-500',
}

const TASK_STATUS_COLORS: Record<string, string> = {
  inbox: 'bg-zinc-500/20 text-zinc-400',
  open: 'bg-blue-500/20 text-blue-400',
  'in-progress': 'bg-amber-500/20 text-amber-400',
  'in-review': 'bg-purple-500/20 text-purple-400',
  done: 'bg-emerald-500/20 text-emerald-400',
}

export function ProjectTaskItem({ item }: { item: Extract<RenderItem, { kind: 'project-task' }> }) {
  const prioColor = PRIO_COLORS[item.priority || 'medium'] || PRIO_COLORS.medium
  const sColor = TASK_STATUS_COLORS[item.taskStatus || ''] || TASK_STATUS_COLORS.inbox

  return (
    <div
      className={cn('rounded-lg border border-primary/15 bg-primary/[0.06] border-l-[3px] overflow-hidden', prioColor)}
    >
      <div className="px-3 py-2 flex items-center gap-2 border-b border-primary/12">
        <span className="text-xs font-mono text-muted-foreground/50">TASK</span>
        <span className="text-sm font-bold text-foreground/90 flex-1 truncate">{item.title}</span>
        {item.taskStatus && (
          <span className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded', sColor)}>
            {item.taskStatus}
          </span>
        )}
        {item.priority && item.priority !== 'medium' && (
          <span className="text-[9px] font-mono text-muted-foreground/40 uppercase">{item.priority}</span>
        )}
      </div>
      {item.tags && item.tags.length > 0 && (
        <div className="px-3 pt-1.5 flex gap-1 flex-wrap">
          {item.tags.map(tag => (
            <span key={tag} className="px-1.5 py-0.5 text-[9px] font-mono bg-indigo-500/15 text-indigo-400/80 rounded">
              {tag}
            </span>
          ))}
        </div>
      )}
      {item.body && (
        <div className="px-3 py-2 text-sm text-foreground/70">
          <Markdown>{item.body}</Markdown>
        </div>
      )}
      <div className="px-3 pb-1.5">
        <span className="text-[9px] font-mono text-muted-foreground/30">{item.id}.md</span>
      </div>
    </div>
  )
}

/**
 * Assistant prose -- the SINGLE renderer for both the in-flight streaming text
 * and the committed assistant entry. `streaming` is the only difference:
 *   streaming=true  : dimmed + emerald live-accent bar + caret, NO copy
 *                     affordances (text is still mutating -- nothing stable to
 *                     copy yet). The `is-streaming` class lights the accent.
 *   streaming=false : full opacity + the rich committed chrome (CopyMenu /
 *                     copy-as-image / hover). The API-error treatment applies to
 *                     committed text only -- a live stream never settles mid-JSON.
 *
 * The box is LAYOUT-IDENTICAL in both states: flush, full width. The emerald
 * accent is a paint-only `::before` bar that BLEEDS LEFT into the gutter
 * (globals.css [data-assistant-text]::before, absolutely positioned -> zero
 * layout width). So the streaming->committed swap (solar-orca's in-place
 * live-slot takeover) cannot re-wrap or shift the text -- only opacity + the
 * bar's opacity change. The settle morph (globals.css `assistant-settle`,
 * triggered by the group wrapper in transcript-view) fades exactly those.
 */
export function AssistantText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const isApiError = !streaming && /^API Error:\s*\d+\s*\{/.test(text)

  if (isApiError) {
    return (
      <div className="text-sm px-3 py-2 bg-destructive/15 border border-destructive/40 rounded font-mono">
        <div className="text-destructive font-bold text-xs uppercase mb-1">API Error</div>
        <pre className="text-[11px] text-destructive/80 whitespace-pre-wrap break-all">{text}</pre>
      </div>
    )
  }

  return (
    <div data-assistant-text className={cn('text-sm group/text relative', streaming && 'is-streaming opacity-75')}>
      <Markdown>{text}</Markdown>
      {streaming ? (
        <span className="inline-block w-1.5 h-4 bg-emerald-500 animate-pulse ml-0.5 align-text-bottom" />
      ) : (
        <CopyMenu
          text={text}
          copyAsImage
          className="absolute top-0 right-0 opacity-60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/text:opacity-60 hover:!opacity-100 transition-opacity"
        />
      )}
    </div>
  )
}

export function TextItem({ item }: { item: Extract<RenderItem, { kind: 'text' }> }) {
  return <AssistantText text={item.text} />
}

export function ImagesItem({ item }: { item: Extract<RenderItem, { kind: 'images' }> }) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {item.images.map(img => (
        <a
          key={img.hash}
          href={img.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
          title={img.originalPath}
        >
          <img
            src={img.url}
            alt={img.originalPath.split('/').pop() || 'image'}
            className="max-w-xs max-h-48 rounded border border-border hover:border-primary transition-colors"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  )
}

export function ToolItem({
  item,
  expandAll,
  planContext,
}: {
  item: Extract<RenderItem, { kind: 'tool' }>
  expandAll: boolean
  planContext?: { content: string; path?: string }
}) {
  return (
    <MemoizedToolLine
      tool={item.tool}
      result={item.result}
      toolUseResult={item.extra}
      isError={item.isError}
      expandAll={expandAll}
      renderAgentInline={renderAgentInline}
      {...(item.tool.name === 'ExitPlanMode' && planContext
        ? { planContent: planContext.content, planPath: planContext.path }
        : {})}
    />
  )
}

export function BashItem({ item }: { item: Extract<RenderItem, { kind: 'bash' }> }) {
  return (
    <div className="text-sm">
      <BashOutput result={item.text} />
    </div>
  )
}
