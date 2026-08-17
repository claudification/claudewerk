import { useCallback, useEffect, useState } from 'react'
import { type GroupBy, GROUP_BY_OPTIONS } from '@/components/project-board/board-grouping'

type Density = 'compact' | 'normal' | 'roomy'
type TitleSize = 'xs' | 'sm'

/**
 * TWO CONTROLS, NOT ONE. `view` is NAVIGATION -- which surface you are looking
 * at. `groupBy` is a MODIFIER -- how the board arranges the cards it is already
 * showing. They used to be a single `mode: 'lanes' | 'epics'`, which forced an
 * epic to be a separate screen rather than an arrangement of the same board,
 * and left the two able to disagree about what the board contained.
 *
 * They are rendered differently on purpose too: `view` is tabs in the header,
 * `groupBy` is a labelled select down in the filter row. A control that changes
 * where you are must not look like a control that changes what you see.
 */
export type BoardView = 'board' | 'epics'

export const BOARD_VIEWS: BoardView[] = ['board', 'epics']

export type BoardViewConfig = {
  columnWidth: number
  bodyLines: number
  density: Density
  titleSize: TitleSize
  view: BoardView
  groupBy: GroupBy
}

const BOARD_VIEW_DEFAULTS: BoardViewConfig = {
  columnWidth: 400,
  bodyLines: 6,
  density: 'roomy',
  titleSize: 'sm',
  view: 'board',
  // Grouped by epic out of the box: an ungrouped 400-card board is the thing
  // this redesign exists to fix, so it should not be the state you land on.
  groupBy: 'epic',
}

const STORAGE_KEY = 'rclaude.project-board-view.v2'

/**
 * Old configs stored `mode: 'lanes' | 'epics'`. Read it forward rather than
 * bumping the key -- a version bump would silently reset everyone's column
 * width and density along with it, to fix a field they never set.
 */
function migrateView(parsed: { view?: unknown; mode?: unknown }): BoardView {
  if (typeof parsed.view === 'string' && BOARD_VIEWS.includes(parsed.view as BoardView)) {
    return parsed.view as BoardView
  }
  return parsed.mode === 'epics' ? 'epics' : BOARD_VIEW_DEFAULTS.view
}

function load(): BoardViewConfig {
  if (typeof localStorage === 'undefined') return BOARD_VIEW_DEFAULTS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return BOARD_VIEW_DEFAULTS
    const parsed = JSON.parse(raw)
    return {
      columnWidth: clampNum(parsed.columnWidth, 200, 400, BOARD_VIEW_DEFAULTS.columnWidth),
      bodyLines: clampNum(parsed.bodyLines, 0, 6, BOARD_VIEW_DEFAULTS.bodyLines),
      density: ['compact', 'normal', 'roomy'].includes(parsed.density) ? parsed.density : BOARD_VIEW_DEFAULTS.density,
      titleSize: ['xs', 'sm'].includes(parsed.titleSize) ? parsed.titleSize : BOARD_VIEW_DEFAULTS.titleSize,
      view: migrateView(parsed),
      groupBy: GROUP_BY_OPTIONS.includes(parsed.groupBy) ? parsed.groupBy : BOARD_VIEW_DEFAULTS.groupBy,
    }
  } catch {
    return BOARD_VIEW_DEFAULTS
  }
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function useBoardViewConfig() {
  const [config, setConfig] = useState<BoardViewConfig>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    } catch {}
  }, [config])

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setConfig(load())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const update = useCallback(<K extends keyof BoardViewConfig>(key: K, value: BoardViewConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }))
  }, [])

  const reset = useCallback(() => setConfig(BOARD_VIEW_DEFAULTS), [])

  return { config, update, reset }
}

export const CLAMP_CLASS: Record<number, string> = {
  0: 'hidden',
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
  6: 'line-clamp-6',
}

export const DENSITY_PADDING: Record<Density, string> = {
  compact: 'px-2 py-1',
  normal: 'px-3 py-2',
  roomy: 'px-4 py-3',
}

export const TITLE_SIZE_CLASS: Record<TitleSize, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
}
