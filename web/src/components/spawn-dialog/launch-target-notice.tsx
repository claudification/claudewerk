// The one line under the CWD that explains WHERE this launch is going when the
// user did not pick a project. Two shapes, both non-blocking:
//
//   warn -- nothing was selected at all. Spawning is still allowed (launching
//           into a bare cwd is legitimate), but it is never silent again.
//   info -- the active workspace held exactly one project and we assumed it.
//           An assumption the user did not make deserves to be visible.
//
// Lives outside spawn-dialog.tsx on purpose: that file is already a god file,
// and this keeps the addition there to a single element.
import { FolderSearch, Layers } from 'lucide-react'
import type { LaunchTargetSource } from '@/lib/launch-target'
import { launchTargetNeedsWarning } from '@/lib/launch-target'
import { cn } from '@/lib/utils'

const BOX = 'w-full flex items-center gap-2 px-2 py-1.5 rounded text-[10px] font-mono leading-snug'

function NoProjectWarning({ path }: { path: string }) {
  return (
    <div className={cn(BOX, 'border border-amber-500/40 bg-amber-500/10 text-amber-200')}>
      <FolderSearch className="size-3 shrink-0" />
      <span className="flex-1 min-w-0">
        No project selected -- launching into <span className="font-bold">{path}</span>. Pick a project or a
        conversation first if that is not what you want.
      </span>
    </div>
  )
}

function WorkspaceSoleNotice({ workspaceName }: { workspaceName?: string }) {
  return (
    <div className={cn(BOX, 'text-comment')}>
      <Layers className="size-3 shrink-0 text-primary" />
      <span className="flex-1 min-w-0 truncate">
        Assumed the only project in{' '}
        {workspaceName ? <span className="text-foreground">{workspaceName}</span> : 'this workspace'}
      </span>
    </div>
  )
}

export function LaunchTargetNotice({
  source,
  path,
  workspaceName,
}: {
  source: LaunchTargetSource | undefined
  path: string
  workspaceName?: string
}) {
  if (!source) return null
  if (launchTargetNeedsWarning(source)) return <NoProjectWarning path={path} />
  if (source === 'workspace-sole') return <WorkspaceSoleNotice workspaceName={workspaceName} />
  return null
}
