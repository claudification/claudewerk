/** The revive tab's footer: launch steps, the copy-log button, and the action
 *  row. Wraps LaunchDialogBottom so the container never has to assemble a
 *  diagnostic log inline. */

import type { Conversation } from '@/lib/types'
import { LaunchDialogBottom } from '../launch-monitor'
import { buildReviveLog } from './revive-log'
import type { UseReviveLaunch } from './use-revive-launch'

export function ReviveBottom({
  launch,
  conversationId,
  conversation,
  headless,
  model,
  effort,
  profile,
  originalProfile,
  onRevive,
}: {
  launch: UseReviveLaunch
  conversationId: string | undefined
  conversation: Conversation | undefined
  headless: boolean
  model: string
  effort: string
  profile: string
  originalProfile: string
  onRevive: () => void
}) {
  const displayError = launch.progress.error || launch.progress.launch.error

  return (
    <LaunchDialogBottom
      phase={launch.phase}
      steps={launch.progress.steps}
      displayError={displayError}
      copied={launch.progress.copied}
      onCopyLog={() =>
        launch.progress.copyToClipboard(
          buildReviveLog({
            conversationId,
            conversation,
            agentHostId: launch.agentHostId,
            jobId: launch.jobId,
            headless,
            model,
            effort,
            profile,
            originalProfile,
            steps: launch.progress.steps,
            error: displayError,
            elapsed: launch.progress.elapsed,
            timestamp: new Date().toISOString(),
          }),
        )
      }
      onClose={launch.close}
      onAction={onRevive}
      actionLabel="Revive"
      actionColorClass="bg-emerald-500 text-background hover:bg-emerald-500/90"
      isConnected={launch.progress.isConnected}
      isComplete={launch.progress.isComplete}
      hasError={launch.progress.hasError}
      onViewConversation={launch.viewConversation}
    />
  )
}
