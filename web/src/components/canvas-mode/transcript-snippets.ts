// Flatten transcript entries into compact one-liner rows for the expanded
// card's mini-transcript. Rides the shared parse-entries pipeline (no
// duplicate content parsing); collapses each RenderItem to a short string.
import type { RenderItem } from '@/components/transcript/group-view-types'
import { parseGroupEntries } from '@/components/transcript/parse-entries'
import type { TranscriptEntry } from '@/lib/types'

export interface MiniRow {
  key: string
  role: 'user' | 'assistant' | 'tool' | 'channel'
  text: string
}

const MAX_ROWS = 80

function noResult(): undefined {
  return undefined
}

type RowOf<K extends RenderItem['kind']> = (item: Extract<RenderItem, { kind: K }>) => Pick<MiniRow, 'role' | 'text'>

// Dispatch per RenderItem kind; kinds without a builder (thinking, system)
// stay out of the mini view.
const ROW_BUILDERS: { [K in RenderItem['kind']]?: RowOf<K> } = {
  text: item => ({ role: 'assistant', text: item.text }),
  bash: item => ({ role: 'tool', text: item.text.replace(/<[^>]+>/g, ' ').trim() }),
  tool: item => ({ role: 'tool', text: typeof item.tool.name === 'string' ? item.tool.name : 'tool' }),
  channel: item => ({ role: 'channel', text: `${item.source}: ${item.text}` }),
  'project-task': item => ({ role: 'channel', text: `task: ${item.title}` }),
  images: item => ({ role: 'tool', text: `[${item.images.length} image${item.images.length === 1 ? '' : 's'}]` }),
}

function itemToRow(item: RenderItem): Pick<MiniRow, 'role' | 'text'> | null {
  const builder = ROW_BUILDERS[item.kind] as ((i: RenderItem) => Pick<MiniRow, 'role' | 'text'>) | undefined
  return builder ? builder(item) : null
}

type EntryMeta = TranscriptEntry & { type?: string; seq?: number; uuid?: string }

function entryKey(e: EntryMeta, fallback: number): string | number {
  return e.uuid ?? e.seq ?? fallback
}

/** Plain text from the entry's author stays attributed to that author. */
function resolveRole(entryType: string | undefined, role: MiniRow['role']): MiniRow['role'] {
  return entryType === 'user' && role === 'assistant' ? 'user' : role
}

/** Rows for ONE transcript entry (user text keeps its user role). */
function entryRows(entry: TranscriptEntry, fallbackKey: number): MiniRow[] {
  const e = entry as EntryMeta
  const rows: MiniRow[] = []
  const items = parseGroupEntries([entry], noResult)
  for (let i = 0; i < items.length; i++) {
    const row = itemToRow(items[i])
    if (!row?.text.trim()) continue
    rows.push({ key: `${entryKey(e, fallbackKey)}:${i}`, role: resolveRole(e.type, row.role), text: row.text.trim() })
  }
  return rows
}

function isChatEntry(entry: TranscriptEntry): boolean {
  const type = (entry as EntryMeta).type
  return type === 'user' || type === 'assistant'
}

/** Last MAX_ROWS compact rows for a conversation's cached transcript. */
export function buildMiniRows(entries: TranscriptEntry[]): MiniRow[] {
  const rows = entries.filter(isChatEntry).flatMap((entry, i) => entryRows(entry, i))
  return rows.slice(-MAX_ROWS)
}
