/**
 * Renderer switch: picks the non-virtualized `TranscriptViewPlain` (DEFAULT) or
 * the legacy TanStack virtualized `TranscriptView` based on the per-device
 * `transcriptRenderer` pref (Settings > Experiments). Both renderers share the
 * window/scrollback data logic, grouping, group rendering and tail animations
 * -- only the scroll/measure machinery differs. Switching remounts the view,
 * which is exactly the clean-slate both engines want.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { TranscriptViewPlain } from './plain/transcript-view-plain'
import { TranscriptView, type TranscriptViewProps } from './transcript-view'

export function TranscriptViewSwitch(props: TranscriptViewProps) {
  const renderer = useConversationsStore(state => state.controlPanelPrefs.transcriptRenderer)
  return renderer === 'virtualized' ? <TranscriptView {...props} /> : <TranscriptViewPlain {...props} />
}
