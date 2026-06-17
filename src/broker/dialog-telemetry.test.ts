import { describe, expect, it } from 'bun:test'
import { DIALOG_TURN_WARN_THRESHOLD, dialogTurnCount, recordDialogTurn, resetDialogTurnStats } from './dialog-telemetry'

function capture() {
  const lines: string[] = []
  return { log: { info: (m: string) => lines.push(m) }, lines }
}

describe('dialog-telemetry', () => {
  it('counts earned turns per dialog and exposes the count', () => {
    resetDialogTurnStats()
    const { log } = capture()
    expect(recordDialogTurn('conv1', 'dlg1', 0, log)).toBe(1)
    expect(recordDialogTurn('conv1', 'dlg1', 10, log)).toBe(2)
    expect(dialogTurnCount('dlg1')).toBe(2)
    expect(dialogTurnCount('unknown')).toBe(0)
  })

  it('tracks dialogs independently', () => {
    resetDialogTurnStats()
    const { log } = capture()
    recordDialogTurn('conv1', 'a', 0, log)
    recordDialogTurn('conv1', 'b', 0, log)
    recordDialogTurn('conv1', 'a', 1, log)
    expect(dialogTurnCount('a')).toBe(2)
    expect(dialogTurnCount('b')).toBe(1)
  })

  it('logs a structured line every turn with ids, count and span', () => {
    resetDialogTurnStats()
    const { log, lines } = capture()
    recordDialogTurn('conversationXYZ', 'dialogABC', 100, log)
    recordDialogTurn('conversationXYZ', 'dialogABC', 350, log)
    expect(lines[0]).toContain('[dialog-telemetry] turn')
    expect(lines[0]).toContain('dialog=dialogAB')
    expect(lines[0]).toContain('conv=conversa')
    expect(lines[1]).toContain('turns=2')
    expect(lines[1]).toContain('spanMs=250')
  })

  it('marks OVERUSE once the soft threshold is crossed', () => {
    resetDialogTurnStats()
    const { log, lines } = capture()
    for (let i = 0; i < DIALOG_TURN_WARN_THRESHOLD; i++) recordDialogTurn('c', 'd', i, log)
    expect(lines.slice(0, DIALOG_TURN_WARN_THRESHOLD - 1).every(l => !l.includes('OVERUSE'))).toBe(true)
    expect(lines[DIALOG_TURN_WARN_THRESHOLD - 1]).toContain('OVERUSE')
  })

  it('resets the rollup', () => {
    resetDialogTurnStats()
    const { log } = capture()
    recordDialogTurn('c', 'd', 0, log)
    resetDialogTurnStats()
    expect(dialogTurnCount('d')).toBe(0)
  })
})
