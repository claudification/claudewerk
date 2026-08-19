import { HoverCard } from '@/components/ui/hover-card'
import { PlaceCard } from './place-card'

/**
 * The hit-target on a project header that floats the PLACE card: hover on a
 * pointer, TAP on touch (`openOnTap`, so the phone gets the card too instead of
 * selecting the project underneath).
 *
 * Lazily rendered content -- the card's hooks (board counts, commit aggregates,
 * git snapshot) only run while the panel is open, so a list of thirty projects
 * costs nothing until one is actually hovered.
 */
export function PlaceScopeAffordance({ project }: { project: string }) {
  return (
    <HoverCard openOnTap panel={() => <PlaceCard project={project} />} className="shrink-0">
      {/* nested inside the project-header interactive; a <button> would nest buttons */}
      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role */}
      <span
        role="button"
        tabIndex={0}
        className="text-[10px] text-fg-faint hover:text-accent cursor-pointer transition-colors"
        title="Project overview"
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
        }}
      >
        {'ⓘ'}
      </span>
    </HoverCard>
  )
}
