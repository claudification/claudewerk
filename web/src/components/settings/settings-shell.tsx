import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { SettingsNavRail, SettingsNavStrip, type SettingsShellTab } from './settings-nav'

export type { SettingsShellTab }

interface SettingsShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  tabs: SettingsShellTab[]
  activeTab: string
  onTabChange: (tab: string) => void
  showTabs?: boolean
  headerContent?: ReactNode
  footer?: ReactNode
  children: ReactNode
  maxWidth?: 'sm' | 'md' | 'lg'
  /** Desktop-first layout: wide fixed-height dialog with a left nav rail
   *  (mobile keeps a horizontal tab strip). Default = legacy narrow stack. */
  wide?: boolean
}

const MAX_WIDTH_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
} as const

export function SettingsShell(props: SettingsShellProps) {
  return props.wide ? <WideShell {...props} /> : <StackedShell {...props} />
}

function WideShell({
  open,
  onOpenChange,
  title,
  tabs,
  activeTab,
  onTabChange,
  showTabs = true,
  headerContent,
  footer,
  children,
}: SettingsShellProps) {
  const nav = showTabs && tabs.length > 1
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 overflow-hidden flex flex-col w-[94vw] sm:max-w-[960px] h-[85vh]">
        <div className="flex items-center gap-4 px-4 sm:px-6 pt-4 pb-3 pr-12 border-b border-border shrink-0">
          <DialogTitle className="uppercase tracking-wider shrink-0">{title}</DialogTitle>
          {headerContent && <div className="flex-1 max-w-xs ml-auto">{headerContent}</div>}
        </div>
        {nav && <SettingsNavStrip tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />}
        <div className="flex flex-1 min-h-0">
          {nav && <SettingsNavRail tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />}
          <div className="flex-1 min-w-0 overflow-y-auto px-4 sm:px-6 py-4 space-y-3">{children}</div>
        </div>
        {footer && <div className="px-4 sm:px-6 py-3 border-t border-border shrink-0">{footer}</div>}
      </DialogContent>
    </Dialog>
  )
}

function StackedShell({
  open,
  onOpenChange,
  title,
  tabs,
  activeTab,
  onTabChange,
  showTabs = true,
  headerContent,
  footer,
  children,
  maxWidth = 'lg',
}: SettingsShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('p-0 gap-0 max-h-[85vh] overflow-hidden flex flex-col', MAX_WIDTH_CLASS[maxWidth])}>
        <div className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle className="uppercase tracking-wider">{title}</DialogTitle>
        </div>

        {headerContent && <div className="px-6 pt-4 pb-2 shrink-0">{headerContent}</div>}

        {showTabs && tabs.length > 1 && (
          <div className="px-6 pb-2 pt-3 shrink-0">
            <Tabs value={activeTab} onValueChange={onTabChange} className="gap-0">
              <TabsList
                variant="line"
                className="h-8 w-full gap-0 justify-start border-b border-border rounded-none px-0"
              >
                {tabs.map(t => (
                  <TabsTrigger
                    key={t.id}
                    value={t.id}
                    className="text-[11px] font-mono uppercase tracking-wider px-3 py-1 flex-none"
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {tabs.map(t => (
                <TabsContent key={t.id} value={t.id} className="hidden" />
              ))}
            </Tabs>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-3">{children}</div>

        {footer && <div className="px-6 py-3 border-t border-border shrink-0">{footer}</div>}
      </DialogContent>
    </Dialog>
  )
}
