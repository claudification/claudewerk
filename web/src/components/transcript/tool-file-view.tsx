/**
 * How a tool line shows the file it touched -- its NAME and its CONTENT.
 *
 * Almost always a shortened path and a syntax-highlighted source dump. But
 * `.rclaude/project/cards/<id>.md` is a board CARD: it has a lane, a title and
 * an editor. So the name renders as the card (exactly like a card link in
 * markdown does) and the content renders as the card that was written, not as
 * YAML frontmatter followed by markdown source.
 *
 * Both fall back to the plain file treatment the moment anything does not fit
 * -- an unparseable card is a source dump, never an error. The raw bytes stay
 * one click away in the JSON inspector either way.
 */

import type { ReactNode } from 'react'
import { CardChip } from '@/components/cards/card-chip'
import { CardPreview } from '@/components/cards/card-preview'
import { parseCardContent } from '@/lib/cards/card-content'
import { parseProjectCardPath } from '@/lib/project-card-link'
import { shortPath } from './shared'
import { WritePreview } from './tool-renderers'

function isCardPath(path: string): boolean {
  return Boolean(path) && parseProjectCardPath(path) !== null
}

export function fileLabel(path: string): ReactNode {
  const short = shortPath(path) || path
  return isCardPath(path) ? <CardChip path={path} fallback={short} /> : short
}

export function filePreview(path: string, content: string): ReactNode {
  const card = isCardPath(path) ? parseCardContent(content) : null
  return card ? <CardPreview card={card} /> : <WritePreview content={content} filePath={path} />
}
