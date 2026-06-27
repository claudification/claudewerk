import { useState } from 'react'
import { useDispatchStore } from './dispatch-store'

interface ProjectSotu {
  project: string
  projectUri: string
  slug: string
  enabled: boolean
  state: { lastDistillAt: number; pendingContribs: number; genAt: number }
  queueSize: number
  view: {
    chronicle: { now: unknown[]; justDone: unknown[]; narrative: string; generatedAt?: number }
    holds: unknown[]
    alerts: unknown[]
  }
  config: unknown
}

interface FleetDump {
  projects: ProjectSotu[]
  ts: number
}

function ago(ms: number, now: number): string {
  if (!ms) return 'never'
  const diff = now - ms
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  return `${Math.round(diff / 3600_000)}h ago`
}

function ProjectCard({ p, now }: { p: ProjectSotu; now: number }) {
  const [expanded, setExpanded] = useState(false)
  const narr = p.view.chronicle.narrative?.trim()
  return (
    <div className="rounded-xl border border-border/70 bg-card/40">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`h-2 w-2 rounded-full ${p.enabled ? 'bg-accent' : 'bg-comment/40'}`} />
        <span className="flex-1 font-mono text-[12px] font-medium text-foreground">{p.project}</span>
        <span className="font-mono text-[10px] text-comment">
          {p.queueSize} queued - {p.view.holds.length} holds - {p.view.alerts.length} alerts
        </span>
        <span className="text-[10px] text-comment">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-border/50 px-4 py-3">
          <div className="grid grid-cols-3 gap-3 text-[11px]">
            <div>
              <span className="block text-[9px] uppercase tracking-[0.15em] text-comment">Last distill</span>
              <span className="text-foreground/80">{ago(p.state.lastDistillAt, now)}</span>
            </div>
            <div>
              <span className="block text-[9px] uppercase tracking-[0.15em] text-comment">Pending</span>
              <span className="text-foreground/80">{p.state.pendingContribs} weighted</span>
            </div>
            <div>
              <span className="block text-[9px] uppercase tracking-[0.15em] text-comment">Chronicle age</span>
              <span className="text-foreground/80">{ago(p.view.chronicle.generatedAt ?? 0, now)}</span>
            </div>
          </div>
          {narr && (
            <div className="mt-3">
              <span className="block text-[9px] uppercase tracking-[0.15em] text-comment">Narrative</span>
              <p className="mt-1 text-[11px] leading-relaxed text-foreground/90">{narr}</p>
            </div>
          )}
          {p.view.chronicle.now.length > 0 && (
            <div className="mt-3">
              <span className="block text-[9px] uppercase tracking-[0.15em] text-comment">
                NOW ({p.view.chronicle.now.length})
              </span>
              <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-lg bg-background/50 p-2 font-mono text-[10px] text-comment">
                {JSON.stringify(p.view.chronicle.now, null, 2)}
              </pre>
            </div>
          )}
          {p.view.chronicle.justDone.length > 0 && (
            <div className="mt-3">
              <span className="block text-[9px] uppercase tracking-[0.15em] text-comment">
                JUST DONE ({p.view.chronicle.justDone.length})
              </span>
              <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-lg bg-background/50 p-2 font-mono text-[10px] text-comment">
                {JSON.stringify(p.view.chronicle.justDone, null, 2)}
              </pre>
            </div>
          )}
          {p.view.holds.length > 0 && (
            <div className="mt-3">
              <span className="block text-[9px] uppercase tracking-[0.15em] text-comment">
                HOLDS ({p.view.holds.length})
              </span>
              <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-lg bg-background/50 p-2 font-mono text-[10px] text-comment">
                {JSON.stringify(p.view.holds, null, 2)}
              </pre>
            </div>
          )}
          {p.view.alerts.length > 0 && (
            <div className="mt-3">
              <span className="block text-[9px] uppercase tracking-[0.15em] text-accent">
                ALERTS ({p.view.alerts.length})
              </span>
              <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-lg bg-accent/5 p-2 font-mono text-[10px] text-accent">
                {JSON.stringify(p.view.alerts, null, 2)}
              </pre>
            </div>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-[9px] uppercase tracking-[0.15em] text-comment hover:text-foreground">
              Raw config + state
            </summary>
            <pre className="mt-1 max-h-[300px] overflow-auto whitespace-pre-wrap rounded-lg bg-background/50 p-2 font-mono text-[10px] text-comment">
              {JSON.stringify({ config: p.config, state: p.state, slug: p.slug, uri: p.projectUri }, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  )
}

export function SotuDumpModal() {
  const dump = useDispatchStore(s => s.sotuDump) as FleetDump | null
  const closeSotu = useDispatchStore(s => s.closeSotu)

  if (!dump) return null
  const now = dump.ts || Date.now()
  const enabled = dump.projects.filter(p => p.enabled)
  const disabled = dump.projects.filter(p => !p.enabled)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="mx-4 flex w-full max-w-3xl flex-col gap-3 rounded-xl border border-border bg-background p-5 shadow-2xl"
        style={{ maxHeight: '85vh' }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-foreground">State of the Union</h3>
            <p className="mt-0.5 text-[11px] text-comment">
              {dump.projects.length} projects ({enabled.length} enabled, {disabled.length} disabled)
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1 text-[11px] text-comment hover:bg-card"
            onClick={closeSotu}
          >
            Close
          </button>
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto">
          {enabled.map(p => (
            <ProjectCard key={p.slug} p={p} now={now} />
          ))}
          {disabled.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-[0.15em] text-comment hover:text-foreground">
                {disabled.length} disabled project(s)
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {disabled.map(p => (
                  <ProjectCard key={p.slug} p={p} now={now} />
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
