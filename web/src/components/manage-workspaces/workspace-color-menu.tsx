/** The colour picker for one workspace: a dropdown, not eight swatches. The
 *  flat swatch row cost a full line of every rail row to show seven colours
 *  nobody was looking at -- the trigger shows the one that is set. */

import { ChevronDown } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { cn, haptic } from '@/lib/utils'
import { colorDot, WORKSPACE_COLORS } from '../project-list/workspace-colors'

const menuContentClass =
  'min-w-[130px] bg-popover border border-border rounded-md shadow-xl py-1 z-[100] animate-in fade-in zoom-in-95 duration-100'
const menuItemClass =
  'flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

export function WorkspaceColorMenu({ value, onPick }: { value: string | undefined; onPick: (color: string) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Workspace colour"
          className="h-6 pl-1.5 pr-1 flex items-center gap-1.5 rounded border border-border/60 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:border-border transition-colors"
        >
          <span className={cn('size-2.5 rounded-full', colorDot(value))} />
          {value ?? 'none'}
          <ChevronDown className="size-3 opacity-50" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContentClass} align="start" sideOffset={4}>
          {WORKSPACE_COLORS.map(c => (
            <DropdownMenu.Item
              key={c}
              className={cn(menuItemClass, value === c && 'text-primary')}
              onSelect={() => {
                haptic('tap')
                onPick(c)
              }}
            >
              <span className={cn('size-2.5 rounded-full', colorDot(c))} />
              {c}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
