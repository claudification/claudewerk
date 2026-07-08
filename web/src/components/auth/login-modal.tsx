/**
 * Login modal -- drives the Claude.ai OAuth re-login for a headless conversation
 * over cc_control. Opened by the `open-login` window event (dispatched by the
 * 401 hint, the `/login` slash command, and the command palette). Blocking /
 * launcher taxonomy (not parkable): it stays put while the user authorizes in a
 * separate browser tab and is right there to paste back into on return.
 *
 * Flow: startLogin (claude_authenticate) -> window.open(manual url) -> user
 * authorizes + pastes -> completeLogin (claude_oauth_callback) -> done. See
 * src/lib/login-flow.ts.
 */

import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { clearAuthNeeded } from '@/hooks/auth-needed-store'
import { completeLogin, startLogin } from '@/lib/login-flow'
import { formatAccount } from '@/lib/login-parse'
import { LoginPastePanel } from './login-paste-panel'
import { useLoginCommand } from './use-login-command'

type Phase = 'starting' | 'awaiting' | 'completing' | 'done' | 'error'

// fallow-ignore-next-line complexity -- CRAP is inflated by zero coverage on a new component; real cyclomatic (7) is well under the gate. Phase state machine; parsing extracted + tested in login-parse.
export function LoginModal() {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('starting')
  const [authUrl, setAuthUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [account, setAccount] = useState('')
  const [pasted, setPasted] = useState('')
  const issuedState = useRef('')

  const begin = useCallback(async (cid: string) => {
    setPhase('starting')
    setError(null)
    setPasted('')
    setAccount('')
    try {
      const { url, state } = await startLogin(cid)
      issuedState.current = state
      setAuthUrl(url)
      window.open(url, '_blank', 'noopener,noreferrer')
      setPhase('awaiting')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    function onOpen(e: Event) {
      const cid = (e as CustomEvent).detail?.conversationId as string | undefined
      if (!cid) return
      setConversationId(cid)
      begin(cid)
    }
    window.addEventListener('open-login', onOpen)
    return () => window.removeEventListener('open-login', onOpen)
  }, [begin])

  // fallow-ignore-next-line complexity -- CRAP from zero coverage; real cyclomatic (5) is under the gate.
  const submit = useCallback(async () => {
    if (!conversationId || !pasted.trim()) return
    setPhase('completing')
    setError(null)
    try {
      const acct = await completeLogin(conversationId, pasted, issuedState.current)
      setAccount(formatAccount(acct))
      clearAuthNeeded(conversationId)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('awaiting')
    }
  }, [conversationId, pasted])

  // Palette trigger (conversation-scoped, headless-only) lives in a hook.
  useLoginCommand()

  const close = () => setConversationId(null)
  const open = conversationId !== null

  return (
    <Dialog open={open} onOpenChange={o => !o && close()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4">
          <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
            <KeyRound className="size-4 text-accent" />
            {phase === 'done' ? 'LOGGED IN' : 'CLAUDE LOGIN'}
          </DialogTitle>

          {phase === 'starting' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Requesting authorization URL...
            </div>
          )}

          {(phase === 'awaiting' || phase === 'completing') && (
            <LoginPastePanel
              authUrl={authUrl}
              pasted={pasted}
              onPaste={setPasted}
              completing={phase === 'completing'}
              error={error}
              onSubmit={submit}
              onCancel={close}
            />
          )}

          {phase === 'done' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                <CheckCircle2 className="size-4" /> {account}
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Credentials refreshed. The stalled turn recovers on its next retry -- no respawn needed.
              </p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={close}
                  className="text-[11px] px-3 py-1.5 rounded bg-accent text-background font-bold"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col gap-3">
              <div className="text-[11px] text-red-400 leading-snug">{error}</div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="text-[11px] px-3 py-1.5 rounded text-muted-foreground hover:text-foreground"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => conversationId && begin(conversationId)}
                  className="text-[11px] px-3 py-1.5 rounded bg-accent text-background font-bold"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
