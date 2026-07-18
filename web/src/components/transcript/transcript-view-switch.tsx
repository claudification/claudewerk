/**
 * Renderer A/B switch: picks the TanStack virtualized `TranscriptView` or the
 * non-virtualized `TranscriptViewPlain` based on the per-device
 * `plainTranscript` pref (Settings > Experiments). Both renderers share the
 * window/scrollback data logic, grouping, group rendering and tail animations
 * -- only the scroll/measure machinery differs. Toggling remounts the view,
 * which is exactly the clean-slate both engines want.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { TranscriptViewPlain } from './plain/transcript-view-plain'
import { TranscriptView, type TranscriptViewProps } from './transcript-view'

export function TranscriptViewSwitch(props: TranscriptViewProps) {
  const plain = useConversationsStore(state => state.controlPanelPrefs.plainTranscript)
  return plain ? <TranscriptViewPlain {...props} /> : <TranscriptView {...props} />
}
