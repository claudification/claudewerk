/** The project a row belongs to, rendered as icon + name in the project's own
 *  colour.
 *
 *  PRESENTATIONAL ONLY -- it takes a resolved look, never the store. Callers
 *  render this inside long lists (the Pulse palette runs ~100 rows), so it must
 *  not subscribe to anything or do its own settings lookup per row.
 *
 *  Extracted 2026-08-18: the command palette had this same icon + colour +
 *  display-name markup inlined four times, re-reading
 *  `projectSettings[projectIdentityKey(...)]` on every branch, and Pulse rendered
 *  a bare grey string instead -- so the two surfaces disagreed about what a
 *  project looks like. */

import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { ProjectIcon } from './project-icons'

interface ProjectTagProps {
  /** Already display-formatted (label override applied, path shortened). */
  name: string
  /** Icon id from the ICONS catalog. Absent = no icon, just the name. */
  icon?: string
  /** CSS colour from project settings. Absent = inherit the caller's colour. */
  color?: string
  className?: string
  iconClassName?: string
}

export function ProjectTag({ name, icon, color, className, iconClassName = 'size-3' }: ProjectTagProps) {
  const tint: CSSProperties | undefined = color ? { color } : undefined
  return (
    <span
      className={cn('inline-flex items-center gap-1 min-w-0', className)}
      style={tint}
      title={name}
      // The seam THE WALL clicks. A tag renders inside rows that are already
      // <button>s, so it cannot be one itself; a surface that wants "click the
      // project to scope everything" delegates on this attribute instead. Purely
      // additive -- no listener, no behaviour, nothing to opt into.
      data-project={name}
    >
      {icon && <ProjectIcon iconId={icon} className={cn('shrink-0', iconClassName)} />}
      <span className="truncate">{name}</span>
    </span>
  )
}
