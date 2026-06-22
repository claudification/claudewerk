import { useDispatchStore } from './dispatch-store'

/** The dispatcher's durable MEMORY FILE, shown so the user can SEE what it
 *  remembers long-term (the post-turn digest appends here). Renders nothing
 *  until there's something remembered. */
export function MemorySection() {
  const memory = useDispatchStore(s => s.memory)
  if (!memory.trim()) return null
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.2em] text-comment">what I remember</span>
      <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-border/70 bg-card/40 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-comment">
        {memory}
      </pre>
    </div>
  )
}

/** The dispatcher's virtual-fs scratch workspaces (/work/<x>) -- ephemeral. */
export function WorkspaceSection() {
  const workspaces = useDispatchStore(s => s.workspaces)
  const active = workspaces.filter(w => w.files.length > 0)
  if (active.length === 0) return null
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.2em] text-comment">workspace</span>
      <div className="mt-3 flex flex-col gap-2">
        {active.map(w => (
          <div key={w.workspace} className="rounded-xl border border-border/70 bg-card/40 px-3.5 py-2.5">
            <span className="font-mono text-[12px] text-foreground/90">/work/{w.workspace}</span>
            <span className="mt-0.5 block font-mono text-[11px] leading-snug text-comment">
              {w.files.join('  ·  ')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
