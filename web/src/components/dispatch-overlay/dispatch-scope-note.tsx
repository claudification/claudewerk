import { projectIdentityKey } from '@shared/project-uri'
import { useMemo, useState } from 'react'
import { updateProjectSettings, useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { cn, projectDisplayName } from '@/lib/utils'

/**
 * Tucked footer: which projects the concierge actually covers (dispatchSubscribed).
 * De-emphasised on purpose -- it's config, not the main flow -- but present so the
 * "I couldn't find anyone" case is fixable. Collapsed to a single quiet line.
 */
export function DispatchScopeNote() {
  const conversations = useConversations()
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const [open, setOpen] = useState(false)

  const projects = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of conversations) {
      if (c.status === 'ended') continue
      const key = projectIdentityKey(c.project)
      if (!seen.has(key)) seen.set(key, c.project)
    }
    return [...seen.values()].sort((a, b) => projectDisplayName(a).localeCompare(projectDisplayName(b)))
  }, [conversations])

  if (projects.length === 0) return null
  const covered = projects.filter(p => projectSettings[projectIdentityKey(p)]?.dispatchSubscribed).length

  return (
    <div className="flex-none border-t border-border/40 px-6 py-2.5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[11px] text-comment/70 hover:text-comment focus-visible:outline-none"
      >
        {covered === 0
          ? "I'm not covering any projects yet -- tap to choose"
          : `I cover ${covered} of ${projects.length} projects`}
        <span className="ml-1">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="dispatch-scroll mt-2 flex flex-wrap gap-1.5">
          {projects.map(p => {
            const on = !!projectSettings[projectIdentityKey(p)]?.dispatchSubscribed
            return (
              <button
                key={projectIdentityKey(p)}
                type="button"
                onClick={() => updateProjectSettings(p, { dispatchSubscribed: !on })}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  on
                    ? 'border-[color-mix(in_oklch,var(--accent)_45%,transparent)] text-foreground'
                    : 'border-border text-comment hover:text-foreground',
                )}
                style={on ? { background: 'color-mix(in oklch, var(--accent) 15%, transparent)' } : undefined}
              >
                {projectDisplayName(p)}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
