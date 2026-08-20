/**
 * W2 -- THE WALL's one query box.
 *
 * It is a CONTROLLED input over `wall-filter-store`, and that is the whole
 * design. The wall is a managed surface: its body is MOVED between the inline
 * dialog, the dock and a detached window as raw DOM (surface-body.tsx), and it
 * is disposed and rebuilt on close. Local `useState` would survive the first
 * three and lose the query on the fourth; module-scope state survives all four
 * by construction. The box therefore holds nothing -- it renders `raw` and it
 * writes `raw`, and every pane reads the same store through `useWallFilter`.
 *
 * KEYS. `/` focuses the box, `Esc` leaves it. Both ride `useWallHotkey`, which
 * binds on the wall's OWN document in the CAPTURE phase for the two reasons the
 * ambient handler has: detached, the wall lives in a second document whose
 * events never reach the opener; and Escape has to be taken before Radix's
 * dismissable layer sees it, or leaving the box would close the whole surface.
 * That plumbing was copied verbatim into the W1 scrubber's `T` before it was
 * lifted out -- two hand-written copies of "which window am I in" is one copy
 * too many for something that fails by silently never firing.
 *
 * Escape is only ours WHILE THE BOX HAS FOCUS. Ambient mode uses the same key on
 * the same document, so the rule is: first Escape leaves the box, second leaves
 * ambient. Anything typed anywhere else falls straight through to the handler
 * that owns it.
 */

import { Search } from 'lucide-react'
import { useRef } from 'react'
import { useWallFilterStore } from '@/lib/wall/filter'
import { useWallHotkey } from './use-wall-hotkey'
import { isTypingTarget } from './wall-keys'

/**
 * The grammar, on hover. The placeholder carries the four sigils a first-time
 * viewer will actually reach for; this is the rest of it, so the box itself is
 * the documentation and nobody has to find a help page.
 */
const GRAMMAR = [
  'text        free text over title, project, action, tag',
  '@project    #tag        &host       :model',
  '!  needs you    !!  everything live    !!!  blocked only',
  '~30m  age      $1  cost      %70  context      +over  managed',
  '-x excludes     "quoted" is literal     /  focus     esc  leave',
].join('\n')

export function WallFilterBox() {
  const raw = useWallFilterStore(s => s.raw)
  const setRaw = useWallFilterStore(s => s.setRaw)
  const inputRef = useRef<HTMLInputElement>(null)

  useWallHotkey(inputRef, event => {
    const el = inputRef.current
    if (!el) return
    if (event.key === 'Escape') {
      // Not our Escape unless the box has it. Ambient's own handler, and the
      // dialog underneath, are both still entitled to this key.
      if (el.ownerDocument.activeElement !== el) return
      event.preventDefault()
      // IMMEDIATE, not plain stopPropagation: the ambient handler is bound on
      // the SAME node in the SAME phase, and stopPropagation does nothing to a
      // co-listener. Ambient also declines a typing target, so this holds even
      // if a re-bind ever puts the two in the other order.
      event.stopImmediatePropagation()
      el.blur()
      return
    }
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
    // A `/` typed INTO a field is a slash, not a hotkey -- including this one.
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    el.focus()
  })

  return (
    <div className="wall-filter" title={GRAMMAR}>
      <Search className="size-3 opacity-50" />
      <input
        ref={inputRef}
        type="text"
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder="filter every pane -- @project #tag !urgent ~30m"
        autoComplete="off"
        spellCheck={false}
        aria-label="Filter every pane"
      />
      {!raw && <kbd className="wall-kbd wall-filter-hint">/</kbd>}
    </div>
  )
}
