/**
 * The legend strip. Pure chrome: it names the five band glyphs every pane in
 * this epic reuses, and the keys the shell binds. Nothing here reads a feed.
 *
 * The mockup's five hues map onto the app's own neon tokens rather than being
 * restated as raw oklch -- the mockup copied this palette in the first place,
 * and a second copy is one theme change away from lying.
 */

const BANDS = [
  { glyph: '■', label: 'blocked', color: 'var(--destructive)' },
  { glyph: '▸', label: 'working', color: 'var(--info)' },
  { glyph: '✓', label: 'done', color: 'var(--success)' },
  { glyph: '◆', label: 'needs', color: 'var(--warning)' },
  { glyph: '○', label: 'idle', color: 'var(--comment)' },
]

const KEYS = [
  { key: 'A', label: 'ambient' },
  { key: 'esc', label: 'exit ambient' },
]

export function WallFooter() {
  return (
    <footer className="wall-footer">
      {BANDS.map(band => (
        <span key={band.label}>
          <b style={{ color: band.color }}>{band.glyph}</b> {band.label}
        </span>
      ))}
      <span className="flex-1" />
      {KEYS.map(k => (
        <span key={k.key}>
          <kbd className="wall-kbd">{k.key}</kbd> {k.label}
        </span>
      ))}
    </footer>
  )
}
