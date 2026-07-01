/**
 * THE DIALOGUE — opt-in dialog width -> Tailwind class.
 *
 * Two maps because the two surfaces have different containing blocks:
 *  - The one-shot MODAL is a viewport-centered overlay, so viewport units (vw)
 *    are correct.
 *  - The PERSISTENT inline card is docked INSIDE the (narrower) transcript
 *    column. vw there sizes against the viewport, not the column, so a wide
 *    setting (full=96vw) blows past the column and the column's overflow-hidden
 *    clips the card -- the inline x-overflow bug. The inline map is therefore
 *    COLUMN-RELATIVE (%): calc(100%-1rem) fills the column minus the card's
 *    mx-2 margins; max-w caps narrower intents.
 */
export const DIALOG_WIDTH_CLASS: Record<string, string> = {
  normal: 'sm:w-[560px]',
  wide: 'sm:w-[min(900px,92vw)]',
  full: 'sm:w-[96vw] sm:max-w-[1400px]',
}
