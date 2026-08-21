/**
 * The suggestion list under the filter box.
 *
 * A hand-rolled ARIA listbox, like every other "type and see values" surface in
 * this tree (`markdown-input/autocomplete-dropdown.tsx` is the closest sibling).
 * There is no combobox library in `web/package.json` and this is not the card
 * that adds one -- a `role="listbox"` of `role="option"` divs is the pattern the
 * codebase already agreed on, and a native `<select>` cannot do the job.
 *
 * MOUSEDOWN, NOT CLICK, for accepting. `click` fires after `blur`, and blurring
 * the input closes the list -- so a click would land on a node that is already
 * gone. `preventDefault` on mousedown also keeps focus in the box, which is what
 * makes accepting-then-typing-more work.
 */

import { cn } from '@/lib/utils'
import { SIGIL_LABEL, type SuggestSigil } from './wall-filter-suggest'

interface WallFilterSuggestListProps {
  sigil: SuggestSigil
  values: readonly string[]
  selected: number
  onAccept: (value: string) => void
  onHover: (index: number) => void
  /** The `<input>`'s id, so the listbox can be named by the same control. */
  inputId: string
}

export function WallFilterSuggestList({
  sigil,
  values,
  selected,
  onAccept,
  onHover,
  inputId,
}: WallFilterSuggestListProps) {
  return (
    // ARIA listbox/option: a native <select> cannot render an autocomplete.
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
    <div
      role="listbox"
      id={`${inputId}-suggest`}
      aria-label={`${SIGIL_LABEL[sigil]} suggestions`}
      className="wall-filter-suggest"
    >
      {values.map((value, i) => (
        // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
        <div
          key={value}
          id={`${inputId}-suggest-${i}`}
          role="option"
          aria-selected={i === selected}
          tabIndex={-1}
          className={cn('wall-filter-suggest-row', i === selected && 'is-on')}
          onMouseDown={event => {
            event.preventDefault()
            onAccept(value)
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="wall-filter-suggest-sigil">{sigil}</span>
          {value}
        </div>
      ))}
    </div>
  )
}
