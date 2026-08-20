/**
 * THE SQUARES -- twelve months of days, one column per week.
 *
 * THREE STATES, THREE VISUALS, and they are three CLASSES rather than three
 * shades of one ramp. `empty` is an outline; `unavailable` is hatched and dimmer
 * than the outline; `active` is the only thing that is ever filled. Switching
 * the metric from `commits` to `turns` therefore makes eleven months visibly go
 * NO DATA rather than visibly go idle -- which is the entire reason the payload
 * carries three states instead of a number and a zero.
 *
 * A SQUARE IS A BUTTON, not a `div` with a click handler. The grid is a control
 * (click scopes the wall to that day) and 366 of them need to be reachable by
 * keyboard and announced by a screen reader; `aria-label` carries the day and
 * its reading because a coloured square says nothing on its own.
 *
 * IT SCROLLS SIDEWAYS, PINNED TO THE RIGHT. A year of weeks is wider than any
 * column of this wall, and the end a reader wants first is TODAY.
 */

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { ActivityMonthLabel, ActivitySquare, ActivityWeek } from '@/lib/wall/activity-grid'

const DOW_LABELS = ['', 'MON', '', 'WED', '', 'FRI', '']

interface ActivitySquaresProps {
  weeks: readonly ActivityWeek[]
  months: readonly ActivityMonthLabel[]
  /** The day currently scoped by the shared filter, `YYYY-MM-DD` or null. */
  scopedDay: string | null
  /** What each square is worth, for the label a screen reader reads. */
  reading: (square: ActivitySquare) => string
  onHover: (index: number | null) => void
  onPick: (day: string) => void
}

export function ActivitySquares({ weeks, months, scopedDay, reading, onHover, onPick }: ActivitySquaresProps) {
  const scroller = useRef<HTMLDivElement>(null)

  // Land on TODAY. The freshest week is the right-hand edge, and a grid that
  // opened on last September would have the reader drag before reading.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])

  return (
    <div className="wall-activity-scroll" ref={scroller} onMouseLeave={() => onHover(null)}>
      <div className="wall-activity-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, 11px)` }}>
        {months.map(m => (
          <span key={m.label + m.week} style={{ gridColumnStart: m.week + 1 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="wall-activity-body">
        <div className="wall-activity-dow">
          {DOW_LABELS.map((label, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the weekday row IS the index
            <span key={i}>{label}</span>
          ))}
        </div>
        <div className="wall-activity-weeks">
          {weeks.map(week => (
            <div className="wall-activity-week" key={week.key}>
              {week.squares.map((square, row) =>
                square === null ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a pad has no day to key on
                  <span className="wall-activity-pad" key={`${week.key}-pad-${row}`} />
                ) : (
                  <button
                    type="button"
                    key={square.day.day}
                    className={cn(
                      'wall-activity-cell',
                      `is-${square.cell.state}`,
                      square.level > 0 && `lvl-${square.level}`,
                      scopedDay === square.day.day && 'is-scoped',
                    )}
                    data-day={square.day.day}
                    data-state={square.cell.state}
                    aria-label={reading(square)}
                    aria-pressed={scopedDay === square.day.day}
                    onMouseEnter={() => onHover(square.index)}
                    onFocus={() => onHover(square.index)}
                    onClick={() => onPick(square.day.day)}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
