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
 *
 * AUTOCOMPLETE PUTS A THIRD STEP AT THE FRONT of that Escape ladder: with a
 * suggestion list open, the first Escape closes the list, the second leaves the
 * box, the third leaves ambient. It has to be decided HERE rather than on the
 * input, because the box's Escape is taken on the document in the CAPTURE phase
 * and a handler on the input would never see the key first. Everything else
 * about the dropdown lives in `use-wall-filter-suggest.ts`.
 */

import { Search } from 'lucide-react'
import { useRef } from 'react'
import { useWallFilterStore } from '@/lib/wall/filter'
import { useWallFilterSuggest } from './use-wall-filter-suggest'
import { useWallHotkey } from './use-wall-hotkey'
import { WallFilterSuggestList } from './wall-filter-suggest-list'
import { isTypingTarget } from './wall-keys'

/**
 * The grammar, on hover. The placeholder carries the four sigils a first-time
 * viewer will actually reach for; this is the rest of it, so the box itself is
 * the documentation and nobody has to find a help page.
 */
const GRAMMAR = [
  'text        free text over title, project, action, tag',
  '@project    #tag        &host       :model      ^workspace',
  '!  needs you    !!  everything live    !!!  blocked only',
  '~30m  age      $1  cost      %70  context      +over  managed',
  '-x excludes     "quoted" is literal     /  focus     esc  leave',
  'typing a sigil suggests what the fleet actually has -- tab to take it',
].join('\n')

/** One id, so the input can point `aria-activedescendant` at a row of the list
 *  it controls. The box is a singleton on the wall, so a constant is honest. */
const BOX_ID = 'wall-filter-input'

/**
 * ESCAPE, ONE RUNG AT A TIME: the suggestion list, then the box, then whatever
 * is underneath (ambient, then the surface).
 *
 * Taken on the document in the CAPTURE phase, which is why it cannot live on the
 * input: the wall's other Escape handlers are bound on the same node in the same
 * phase, and an input-level handler would only ever see the key after them.
 *
 * Returns true when it spent the key, so the caller can stop.
 */
function spendEscape(el: HTMLInputElement, event: KeyboardEvent, dismissList: () => boolean): boolean {
  // Not our Escape unless the box has it. Ambient's own handler, and the dialog
  // underneath, are both still entitled to this key.
  if (el.ownerDocument.activeElement !== el) return false
  event.preventDefault()
  // IMMEDIATE, not plain stopPropagation: the ambient handler is bound on the
  // SAME node in the SAME phase, and stopPropagation does nothing to a
  // co-listener. Ambient also declines a typing target, so this holds even if a
  // re-bind ever puts the two in the other order.
  event.stopImmediatePropagation()
  // The dropdown gets the FIRST Escape, and only when there is one open -- so a
  // closed list never costs the user a keypress.
  if (!dismissList()) el.blur()
  return true
}

export function WallFilterBox() {
  const raw = useWallFilterStore(s => s.raw)
  const setRaw = useWallFilterStore(s => s.setRaw)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggest = useWallFilterSuggest(raw, setRaw, inputRef)

  useWallHotkey(inputRef, event => {
    const el = inputRef.current
    if (!el) return
    if (event.key === 'Escape') {
      spendEscape(el, event, suggest.dismiss)
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
        id={BOX_ID}
        type="text"
        value={raw}
        onChange={e => {
          setRaw(e.target.value)
          suggest.onCaret(e.target.selectionStart ?? e.target.value.length)
        }}
        // Every other way the caret can move: clicking into the middle of a
        // token, arrowing along it, selecting part of it.
        onSelect={e => suggest.onCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={e => {
          if (suggest.onKeyDown(e)) e.preventDefault()
        }}
        placeholder="filter every pane -- @project #tag ^workspace !urgent ~30m"
        autoComplete="off"
        spellCheck={false}
        aria-label="Filter every pane"
        role="combobox"
        aria-expanded={suggest.sigil !== null}
        aria-controls={`${BOX_ID}-suggest`}
        aria-activedescendant={suggest.sigil ? `${BOX_ID}-suggest-${suggest.selected}` : undefined}
      />
      {!raw && <kbd className="wall-kbd wall-filter-hint">/</kbd>}
      {suggest.sigil && (
        <WallFilterSuggestList
          sigil={suggest.sigil}
          values={suggest.values}
          selected={suggest.selected}
          onAccept={suggest.accept}
          onHover={suggest.setSelected}
          inputId={BOX_ID}
        />
      )}
    </div>
  )
}
