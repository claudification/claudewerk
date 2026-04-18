import { cn } from '@/lib/utils'
import type { CommandResultsProps, PaletteCommand } from './types'

interface CommandRowProps {
  command: PaletteCommand
  active: boolean
  onMouseEnter: () => void
  dim?: boolean
}

export function CommandRow({ command, active, onMouseEnter, dim }: CommandRowProps) {
  return (
    <button
      type="button"
      onClick={command.action}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full px-3 py-2 flex items-center justify-between gap-2 text-left transition-colors',
        active ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
      )}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span
          className={cn(
            'text-[9px] font-bold uppercase shrink-0 px-1 py-0.5',
            dim ? 'bg-[#33467c]/25 text-[#565f89]' : 'bg-[#bb9af7]/20 text-[#bb9af7]',
          )}
        >
          cmd
        </span>
        <span className={cn('text-xs truncate', dim ? 'text-[#8b93b7]' : 'text-[#a9b1d6]')}>{command.label}</span>
      </span>
      {(command.shortcuts || (command.shortcut ? [command.shortcut] : [])).length > 0 && (
        <span className="flex items-center gap-1.5 shrink-0">
          {(command.shortcuts || [command.shortcut!]).map(s => (
            <kbd key={s} className="px-1.5 py-0.5 bg-[#33467c]/30 text-[10px] text-[#565f89]">
              {s}
            </kbd>
          ))}
        </span>
      )}
    </button>
  )
}

export function CommandResults({ commands, activeIndex, setActiveIndex }: CommandResultsProps) {
  if (commands.length === 0) {
    return <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">No matching commands</div>
  }

  return (
    <>
      {commands.map((cmd, i) => (
        <CommandRow key={cmd.id} command={cmd} active={i === activeIndex} onMouseEnter={() => setActiveIndex(i)} />
      ))}
    </>
  )
}
