/**
 * The one question every wall key handler has to ask first: is the user typing?
 *
 * Two handlers now bind keys on the wall's own document -- ambient's `A` / `Esc`
 * and the filter box's `/` -- and both have to stand down inside a text field.
 * Kept here rather than copied into each, because the two copies drifting is how
 * `A` ends up toggling ambient mid-word in one of them.
 */

/** True for anything that eats printable keystrokes. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
