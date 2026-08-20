/**
 * The card seam, assembled. Import from here, never from a provider file --
 * that is what keeps components ignorant of which backend answered.
 *
 * Adding a backend = one more `registerCardProvider()` below (plus its file).
 * Registration order is match order: register specific href shapes (a GitHub
 * issue URL) before broad ones.
 */

import { projectBoardProvider } from './provider-project-board'
import { registerCardProvider } from './registry'

registerCardProvider(projectBoardProvider)

export { cardGlyph } from './glyph'
export { projectBoardCardRef } from './provider-project-board'
export {
  cardRefKey,
  matchCardHref,
  peekCard,
  registerCardProvider,
  resetCardProviders,
  resolveCard,
  resolveCardDeep,
  subscribeCards,
} from './registry'
export { CARD_STATE_STYLE } from './state-style'
export type { CardLookup, CardProgress, CardProvider, CardRef, CardSummary } from './types'
