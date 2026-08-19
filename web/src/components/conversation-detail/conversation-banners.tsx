import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { BannerButton, BannerStack, ConversationBanner } from '@/components/ui/conversation-banner'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useInlinePermissionRegistry } from '@/lib/inline-permission-registry'
import { canTerminal, projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { formatPermissionInput } from './permission-input-preview'

// ---------------------------------------------------------------------------
// LinkRequestBanners
// ---------------------------------------------------------------------------

export function LinkRequestBanners({ conversationId }: { conversationId: string }) {
  const requests = useConversationsStore(s => s.pendingProjectLinks)
  const respond = useConversationsStore(s => s.respondToProjectLink)

  const relevant = requests.filter(r => r.toConversation === conversationId || r.fromConversation === conversationId)

  return (
    <BannerStack
      items={relevant}
      render={req => (
        <ConversationBanner
          key={`${req.fromConversation}:${req.toConversation}`}
          accent="teal"
          label="LINK"
          layout="row"
          title={
            <>
              <span className="text-teal-300">{req.fromProject}</span>
              {' -> '}
              <span className="text-teal-300">{req.toProject}</span>
            </>
          }
          actions={
            <>
              <BannerButton
                accent="emerald"
                label="ALLOW"
                size="sm"
                onClick={() => {
                  haptic('success')
                  respond(req.fromConversation, req.toConversation, 'approve')
                }}
              />
              <BannerButton
                accent="red"
                label="BLOCK"
                size="sm"
                onClick={() => {
                  haptic('error')
                  respond(req.fromConversation, req.toConversation, 'block')
                }}
              />
            </>
          }
        />
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// PermissionBanners
// ---------------------------------------------------------------------------

export function PermissionBanners({ conversationId }: { conversationId: string }) {
  const permissions = useConversationsStore(s => s.pendingPermissions)
  const respond = useConversationsStore(s => s.respondToPermission)
  const allowAlways = useConversationsStore(s => s.allowPermissionAlways)
  const conversationPath = useConversationsStore(s => projectPath(s.conversationsById[conversationId]?.project ?? ''))
  const coveredInline = useInlinePermissionRegistry(s => s.mounted)
  // The gate is answerable from the inline card at the tool call whenever that
  // card is mounted; showing the pinned banner too would ask the same question
  // twice. Scroll the call out of view and the card unmounts -- the banner comes
  // back, which is how you reach a gate you can no longer see.
  const relevant = permissions.filter(p => p.conversationId === conversationId && !coveredInline.includes(p.requestId))
  return (
    <BannerStack
      items={relevant}
      render={perm => (
        <ConversationBanner
          key={perm.requestId}
          accent="amber"
          label="PERMISSION"
          title={<span className="font-bold">{perm.toolName}</span>}
          meta={perm.requestId}
          actions={
            <>
              <BannerButton
                accent="emerald"
                label="ALLOW"
                onClick={() => {
                  haptic('success')
                  respond(perm.conversationId, perm.requestId, 'allow')
                }}
              />
              <BannerButton
                accent="blue"
                label="ALWAYS"
                onClick={() => {
                  haptic('double')
                  allowAlways(perm.conversationId, perm.requestId, perm.toolName)
                }}
              />
              <BannerButton
                accent="red"
                label="DENY"
                onClick={() => {
                  haptic('error')
                  respond(perm.conversationId, perm.requestId, 'deny')
                }}
              />
            </>
          }
        >
          {perm.description && <div className="text-foreground/70 text-[11px]">{perm.description}</div>}
          {perm.inputPreview && formatPermissionInput(perm.toolName, perm.inputPreview, conversationPath)}
        </ConversationBanner>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// SpawnApprovalBanners -- in-panel prompt for spawn requests from non-benevolent
// callers. Mirrors the Permission/AskQuestion family: same ConversationBanner
// primitive, same haptic vocabulary. Pending state lives on the broker
// (caller.pendingSpawnApproval, persisted) and is mirrored into each Conversation's
// pendingSpawnApproval field via conversation_update broadcasts -- reload and
// broker restart both rehydrate the prompt for free.
// ---------------------------------------------------------------------------

function relativizeCwd(cwd: unknown, root?: string): string {
  if (typeof cwd !== 'string') return ''
  if (root && cwd.startsWith(`${root}/`)) return cwd.slice(root.length + 1)
  return cwd
}

export function SpawnApprovalBanners({ conversationId }: { conversationId: string }) {
  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  const respond = useConversationsStore(s => s.respondToSpawnApproval)
  const conversationPath = useConversationsStore(s => projectPath(s.conversationsById[conversationId]?.project ?? ''))
  const [persistChecked, setPersistChecked] = useState(false)

  const pending = conversation?.pendingSpawnApproval
  const items = useMemo(() => (pending ? [pending] : []), [pending])

  // react-doctor-disable-next-line react-doctor/no-derived-state -- multi-source: persistChecked set by user checkbox AND reset on requestId change
  const [prevRequestId, setPrevRequestId] = useState(pending?.requestId)
  if (pending?.requestId !== prevRequestId) {
    setPrevRequestId(pending?.requestId)
    setPersistChecked(false)
  }

  return (
    <BannerStack
      items={items}
      // fallow-ignore-next-line complexity
      render={req => {
        const cwd = relativizeCwd(req.request.cwd, conversationPath)
        const prompt = typeof req.request.prompt === 'string' ? req.request.prompt : ''
        const host = typeof req.request.sentinel === 'string' ? req.request.sentinel : undefined
        const model = typeof req.request.model === 'string' ? req.request.model : undefined
        const permissionMode = typeof req.request.permissionMode === 'string' ? req.request.permissionMode : undefined
        return (
          <ConversationBanner
            key={req.requestId}
            accent="violet"
            label="SPAWN"
            title={
              <>
                <span className="font-bold text-amber-300">{cwd || '(no cwd)'}</span>
                {host && <span className="text-muted-foreground"> @ {host}</span>}
              </>
            }
            meta={req.requestId.slice(0, 8)}
            actions={
              <>
                <BannerButton
                  accent="emerald"
                  label="ALLOW"
                  onClick={() => {
                    haptic('success')
                    respond(conversationId, req.requestId, 'allow', persistChecked)
                  }}
                />
                <BannerButton
                  accent="red"
                  label="DENY"
                  onClick={() => {
                    haptic('error')
                    respond(conversationId, req.requestId, 'deny', false)
                  }}
                />
              </>
            }
          >
            <div className="space-y-2">
              <div className="text-foreground/70 text-[11px]">{req.reason}</div>
              {prompt && (
                <pre className="text-muted-foreground text-[10px] bg-background/50 px-2 py-1 rounded max-h-20 overflow-hidden whitespace-pre-wrap">
                  {prompt.length > 400 ? `${prompt.slice(0, 400)}...` : prompt}
                </pre>
              )}
              {(model || permissionMode) && (
                <div className="text-[10px] text-muted-foreground flex gap-3">
                  {model && (
                    <span>
                      <span className="text-foreground/60">model:</span> {model}
                    </span>
                  )}
                  {permissionMode && (
                    <span>
                      <span className="text-foreground/60">permission:</span> {permissionMode}
                    </span>
                  )}
                </div>
              )}
              <label className="flex items-center gap-2 text-[11px] text-foreground/80 cursor-pointer pt-1 select-none">
                <input
                  type="checkbox"
                  checked={persistChecked}
                  onChange={e => setPersistChecked(e.target.checked)}
                  className="accent-emerald-400 size-3.5"
                />
                <span>
                  Allow future spawn calls from <span className="text-amber-300">this conversation</span> (not the whole
                  project)
                </span>
              </label>
            </div>
          </ConversationBanner>
        )
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// ClipboardBanners
// ---------------------------------------------------------------------------

export function ClipboardBanners({ conversationId }: { conversationId: string }) {
  const captures = useConversationsStore(s => s.clipboardCaptures)
  const dismiss = useConversationsStore(s => s.dismissClipboard)
  const relevant = captures.filter(c => c.conversationId === conversationId)

  return (
    <BannerStack
      items={relevant}
      render={cap => (
        <ConversationBanner
          key={cap.id}
          accent="cyan"
          label="CLIPBOARD"
          title={<span className="text-muted-foreground text-[10px]">{cap.contentType}</span>}
          meta={new Date(cap.timestamp).toLocaleTimeString()}
          actions={
            <div className="flex items-center gap-2 relative z-10">
              <BannerButton
                accent="cyan"
                label="COPY"
                size="lg"
                onClick={() => {
                  // Synchronous textarea copy -- works on iOS Safari without async gesture chain issues
                  const text = cap.text || (cap.base64 ? atob(cap.base64) : '')
                  if (text) {
                    const ta = document.createElement('textarea')
                    ta.value = text
                    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
                    document.body.appendChild(ta)
                    ta.focus()
                    ta.select()
                    document.execCommand('copy')
                    document.body.removeChild(ta)
                    haptic('success')
                    dismiss(cap.id)
                  }
                }}
              />
              <BannerButton
                accent="muted"
                label="DISMISS"
                size="lg"
                onClick={() => {
                  haptic('tick')
                  dismiss(cap.id)
                }}
              />
            </div>
          }
        >
          {cap.contentType === 'text' && cap.text && (
            <pre className="text-foreground/80 text-[10px] bg-background/50 px-2 py-1 rounded max-h-20 overflow-hidden whitespace-pre-wrap">
              {cap.text.length > 500 ? `${cap.text.slice(0, 500)}...` : cap.text}
            </pre>
          )}
          {cap.contentType === 'image' && cap.base64 && (
            <img
              src={`data:${cap.mimeType || 'image/png'};base64,${cap.base64}`}
              alt="clipboard"
              className="max-h-32 max-w-full rounded border border-border-subtle object-contain"
            />
          )}
        </ConversationBanner>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// AskQuestionBanners + AskQuestionCard
// ---------------------------------------------------------------------------

export function AskQuestionBanners({ conversationId }: { conversationId: string }) {
  const questions = useConversationsStore(s => s.pendingAskQuestions)
  const respond = useConversationsStore(s => s.respondToAskQuestion)
  const relevant = questions.filter(q => q.conversationId === conversationId)

  return (
    <BannerStack
      items={relevant}
      gap="loose"
      render={askReq => <AskQuestionCard key={askReq.toolUseId} request={askReq} onRespond={respond} />}
    />
  )
}

function AskQuestionCard({
  request,
  onRespond,
}: {
  request: {
    conversationId: string
    toolUseId: string
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string; preview?: string }>
      multiSelect?: boolean
    }>
    timestamp: number
  }
  onRespond: (
    conversationId: string,
    toolUseId: string,
    answers?: Record<string, string>,
    annotations?: Record<string, { preview?: string; notes?: string }>,
    skip?: boolean,
  ) => void
}) {
  const [selections, setSelections] = useState<Record<string, Set<string>>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [elapsed, setElapsed] = useState(0)
  const hasTty = useConversationsStore(s => {
    const sess = s.conversationsById[request.conversationId]
    return sess ? canTerminal(sess) : false
  })

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - request.timestamp) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [request.timestamp])

  const timeLeft = Math.max(0, 90 - elapsed)
  const isExpiring = timeLeft < 20

  function toggleOption(question: string, label: string, multiSelect?: boolean) {
    haptic('tap')
    setSelections(prev => {
      const current = prev[question] || new Set<string>()
      const next = new Set(current)
      if (multiSelect) {
        if (next.has(label)) next.delete(label)
        else next.add(label)
      } else {
        next.clear()
        next.add(label)
      }
      return { ...prev, [question]: next }
    })
  }

  function handleSubmit() {
    haptic('success')
    const answers: Record<string, string> = {}
    const annots: Record<string, { notes?: string }> = {}
    for (const q of request.questions) {
      const selected = selections[q.question]
      const note = notes[q.question]?.trim()
      if (selected && selected.size > 0) {
        answers[q.question] = [...selected].join(', ')
      } else if (note) {
        answers[q.question] = 'Other'
      }
      if (note) {
        annots[q.question] = { notes: note }
      }
    }
    const hasAnnotations = Object.keys(annots).length > 0
    onRespond(request.conversationId, request.toolUseId, answers, hasAnnotations ? annots : undefined)
  }

  function handleSkip() {
    haptic('tick')
    onRespond(request.conversationId, request.toolUseId, undefined, undefined, true)
  }

  const allAnswered = request.questions.every(q => {
    const selected = selections[q.question]
    return (selected && selected.size > 0) || !!notes[q.question]?.trim()
  })

  return (
    <div
      className={cn(
        'flex flex-col gap-3 px-5 py-4 rounded-lg border-2 font-mono',
        'bg-[#0a1a14] border-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.15),0_0_40px_rgba(16,185,129,0.05)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-bold text-cyan-300 text-sm tracking-wider">QUESTION</span>
        <span
          className={cn(
            'text-xs tabular-nums ml-auto',
            isExpiring ? 'text-red-400 font-bold animate-pulse' : 'text-cyan-500/70',
          )}
        >
          {timeLeft}s
        </span>
      </div>
      {request.questions.map(q => (
        <div key={q.question} className="space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 bg-teal-500/20 text-teal-200 text-xs font-bold uppercase rounded border border-teal-500/30">
              {q.header}
            </span>
            {q.multiSelect && <span className="text-[10px] text-teal-400/70">(select multiple)</span>}
          </div>
          <div className="text-foreground text-sm leading-relaxed font-medium">{q.question}</div>
          <div className="space-y-2">
            {q.options.map(opt => {
              const isSelected = selections[q.question]?.has(opt.label)
              return (
                <button
                  type="button"
                  key={opt.label}
                  onClick={() => toggleOption(q.question, opt.label, q.multiSelect)}
                  className={cn(
                    'w-full text-left px-3.5 py-2.5 border rounded-md transition-all cursor-pointer',
                    isSelected
                      ? 'border-emerald-300 bg-emerald-400/25 text-foreground shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                      : 'border-emerald-700/50 hover:border-emerald-400/70 hover:bg-emerald-400/10 text-foreground/80',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        'shrink-0 w-4.5 h-4.5 border-2 flex items-center justify-center text-[11px] font-bold',
                        q.multiSelect ? 'rounded-sm' : 'rounded-full',
                        isSelected ? 'border-emerald-300 bg-emerald-400 text-emerald-950' : 'border-emerald-600/50',
                      )}
                    >
                      {isSelected && (q.multiSelect ? '\u2713' : '\u25CF')}
                    </span>
                    <span className="font-bold text-[13px]">{opt.label}</span>
                  </div>
                  <div className="text-[11px] text-foreground/50 ml-7 mt-0.5">{opt.description}</div>
                </button>
              )
            })}
          </div>
          <input
            aria-label={`Other answer for: ${q.question}`}
            type="text"
            placeholder="Other (type your answer)"
            value={notes[q.question] || ''}
            onChange={e => setNotes(prev => ({ ...prev, [q.question]: e.target.value }))}
            className="w-full px-3 py-2 text-xs bg-background/40 border border-emerald-800/30 rounded-md text-foreground placeholder:text-fg-faint focus:outline-none focus:border-emerald-400/60"
          />
        </div>
      ))}
      <div className="flex items-center gap-3 mt-1">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={cn(
            'px-6 py-2.5 font-bold text-sm rounded-md border-2 transition-all',
            allAnswered
              ? 'bg-emerald-400 text-emerald-950 border-emerald-300 hover:bg-emerald-300 shadow-[0_0_16px_rgba(16,185,129,0.4)] cursor-pointer'
              : 'bg-muted/20 text-muted-foreground border-border-subtle cursor-not-allowed',
          )}
        >
          Send answers
        </button>
        <button
          type="button"
          onClick={handleSkip}
          title={
            hasTty
              ? 'Dismiss this card and answer in the terminal instead'
              : 'Cancel the question -- the agent is told you declined and continues'
          }
          className="px-4 py-2.5 text-xs font-bold text-muted-foreground hover:text-foreground border border-border-subtle hover:border-border rounded-md transition-colors cursor-pointer"
        >
          {hasTty ? 'SKIP TO TERMINAL' : 'CANCEL'}
        </button>
      </div>
    </div>
  )
}
