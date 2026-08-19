/**
 * Everything below the conversation body: the input bar, the terminal overlay
 * and the revive footer.
 *
 * Split out of conversation-detail.tsx (over the .tsx line bar). The three are
 * grouped because each is a bottom-anchored surface whose visibility is a pure
 * function of the flags already computed above -- no state of their own.
 */

import type { Conversation } from '@/lib/types'
import { InputBar } from './conversation-input'
import { ReviveFooter } from './revive-footer'
import { TerminalOverlay } from './terminal-overlay'

interface DetailFooterProps {
  conversation: Conversation
  activeTab: string
  hasTerminal: boolean
  showTerminal: boolean
  terminalWrapperId: string | null
  canSendInput: boolean
  canSpawn: boolean
  canRevive: boolean
  sentinelConnected: boolean
  /** Truthy while the composer is retargeted at another conversation -- the
   *  local input bar steps aside so the two cannot both claim the keystrokes. */
  conversationTarget: unknown
  inSubagentView: boolean
}

/** The input bar rides the transcript tab, and the tty tab too when that
 *  conversation has no real terminal to type into. */
function showsInput(p: DetailFooterProps): boolean {
  if (p.conversationTarget || !p.canSendInput || p.inSubagentView) return false
  return p.activeTab === 'transcript' || (p.activeTab === 'tty' && !p.hasTerminal)
}

export function DetailFooter(props: DetailFooterProps) {
  const { conversation, showTerminal, terminalWrapperId, canSpawn, canRevive, sentinelConnected } = props
  return (
    <>
      {showsInput(props) && <InputBar conversationId={conversation.id} />}

      {showTerminal && terminalWrapperId && <TerminalOverlay conversationId={terminalWrapperId} />}

      {conversation.status === 'ended' && canSpawn && (
        <ReviveFooter
          conversationId={conversation.id}
          project={conversation.project}
          sentinelConnected={sentinelConnected}
          canRevive={canRevive}
          backend={conversation.backend}
        />
      )}
    </>
  )
}
