/** Right-click menu on a workspace tab: rename, recolour, open the manager, delete. */

import { ContextMenu } from 'radix-ui'
import type { Workspace } from '@/lib/types'
import { cn } from '@/lib/utils'
import { colorDot, WORKSPACE_COLORS } from './workspace-colors'

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

function ColorSub({ current, onRecolor }: { current: string | undefined; onRecolor: (color: string) => void }) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={menuItemClass}>
        Color <span className="ml-auto text-muted-foreground">{'▸'}</span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className="min-w-[120px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          {WORKSPACE_COLORS.map(c => (
            <ContextMenu.Item
              key={c}
              className={cn(menuItemClass, current === c && 'text-primary')}
              onSelect={() => onRecolor(c)}
            >
              <span className={cn('size-2 rounded-full mr-2', colorDot(c))} />
              {c}
            </ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  )
}

export function WorkspaceTabMenu({
  ws,
  onRename,
  onDelete,
  onRecolor,
  onManage,
}: {
  ws: Workspace
  onRename: () => void
  onDelete: () => void
  onRecolor: (color: string) => void
  onManage: () => void
}) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className="min-w-[150px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
        <ContextMenu.Item className={menuItemClass} onSelect={onRename}>
          Rename…
        </ContextMenu.Item>
        <ColorSub current={ws.color} onRecolor={onRecolor} />
        <ContextMenu.Item className={menuItemClass} onSelect={onManage}>
          Manage workspaces…
        </ContextMenu.Item>
        <ContextMenu.Separator className="h-px bg-border my-1" />
        <ContextMenu.Item className={cn(menuItemClass, 'text-destructive')} onSelect={onDelete}>
          Delete workspace
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  )
}
