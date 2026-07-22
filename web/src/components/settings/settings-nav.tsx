import { cn } from '@/lib/utils'

export interface SettingsShellTab {
  id: string
  label: string
}

interface NavProps {
  tabs: SettingsShellTab[]
  activeTab: string
  onTabChange: (tab: string) => void
}

/** Desktop (sm+) vertical section rail for the wide settings shell. */
export function SettingsNavRail({ tabs, activeTab, onTabChange }: NavProps) {
  return (
    <nav
      aria-label="Settings sections"
      className="hidden sm:flex flex-col gap-0.5 w-40 shrink-0 border-r border-border py-3 px-2 overflow-y-auto"
    >
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTabChange(t.id)}
          aria-current={t.id === activeTab ? 'page' : undefined}
          className={cn(
            'text-left px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider transition-colors',
            t.id === activeTab
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
          )}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}

/** Mobile horizontal tab strip for the wide settings shell. */
export function SettingsNavStrip({ tabs, activeTab, onTabChange }: NavProps) {
  return (
    <div className="sm:hidden flex gap-1 overflow-x-auto px-4 py-2 border-b border-border shrink-0">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTabChange(t.id)}
          className={cn(
            'whitespace-nowrap px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border transition-colors',
            t.id === activeTab
              ? 'border-active/50 text-active bg-active/10'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
