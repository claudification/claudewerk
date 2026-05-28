import { type ReactNode, useState } from 'react'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { BackendIcon } from './backend-icon'

const SECRET_KEY_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE/i

function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 12))}${value.slice(-4)}`
}

function LaunchParamRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wider">{label}</span>
      <span className="ml-auto text-foreground/80 truncate max-w-[220px]">{value}</span>
    </div>
  )
}

type CoreRow = { label: string; value: ReactNode }

function backendRow(conversation: Conversation): CoreRow | null {
  const backend = conversation.backend
  if (!backend || backend === 'claude') return null
  return {
    label: 'backend',
    value: (
      <span className="flex items-center gap-1">
        <BackendIcon backend={backend} transport={conversation.transport} size={10} />
        {backend}
      </span>
    ),
  }
}

function modeRow(headless: boolean | undefined): CoreRow | null {
  if (headless === undefined) return null
  return {
    label: 'mode',
    value: <span className={headless ? 'text-sky-400' : 'text-amber-400'}>{headless ? 'headless' : 'PTY'}</span>,
  }
}

function coreLaunchRows(conversation: Conversation): CoreRow[] {
  const lc = conversation.launchConfig
  const headless = lc?.headless ?? (conversation.capabilities?.includes('headless') || undefined)
  const autocompactPct = lc?.autocompactPct ?? conversation.autocompactPct
  const candidates: Array<CoreRow | null> = [
    backendRow(conversation),
    modeRow(headless),
    lc?.permissionMode ? { label: 'perms', value: lc.permissionMode } : null,
    lc?.bare ? { label: 'bare', value: 'yes' } : null,
    lc?.repl ? { label: 'repl', value: 'yes' } : null,
    autocompactPct === undefined ? null : { label: 'autocompact', value: `${autocompactPct}%` },
    lc?.maxBudgetUsd === undefined ? null : { label: 'budget', value: `$${lc.maxBudgetUsd.toFixed(2)}` },
  ]
  return candidates.filter((r): r is CoreRow => r !== null)
}

function LaunchEnvSection({ entries }: { entries: Array<[string, string]> }) {
  const [revealEnv, setRevealEnv] = useState(false)
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2 pb-1">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Env ({entries.length})</span>
        <button
          type="button"
          className="ml-auto text-[9px] text-muted-foreground hover:text-foreground cursor-pointer px-1.5 py-0.5 border border-border hover:border-primary transition-colors"
          onClick={e => {
            e.stopPropagation()
            haptic('tap')
            setRevealEnv(v => !v)
          }}
        >
          {revealEnv ? 'hide secrets' : 'reveal secrets'}
        </button>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] pl-1">
        {entries.map(([k, v]) => {
          const isSecret = SECRET_KEY_PATTERN.test(k)
          const display = isSecret && !revealEnv ? maskSecret(v) : v
          return (
            <div key={k} className="contents">
              <span className="text-muted-foreground truncate max-w-[140px]" title={k}>
                {k}
              </span>
              <span
                className={cn(
                  'text-right tabular-nums truncate',
                  isSecret ? 'text-amber-400/80' : 'text-foreground/70',
                )}
                title={display}
              >
                {display}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function LaunchParamsSection({ conversation }: { conversation: Conversation }) {
  const lc = conversation.launchConfig
  const envEntries = lc?.env ? Object.entries(lc.env) : []
  const coreRows = coreLaunchRows(conversation)
  if (coreRows.length === 0 && envEntries.length === 0) return null
  return (
    <>
      <div className="border-t border-border" />
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Launch</span>
          {!lc && (
            <span className="text-[9px] text-muted-foreground/50" title="launch config not captured at spawn time">
              (partial)
            </span>
          )}
        </div>
        {coreRows.length > 0 && (
          <div className="space-y-1 pl-1">
            {coreRows.map(row => (
              <LaunchParamRow key={row.label} label={row.label} value={row.value} />
            ))}
          </div>
        )}
        {envEntries.length > 0 && <LaunchEnvSection entries={envEntries} />}
      </div>
    </>
  )
}
