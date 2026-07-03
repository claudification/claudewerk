/**
 * Sampling controls for the Regenerate form: a temperature slider and an
 * (optional) max-tokens override. Split out to keep the form under the file-size
 * bar; purely presentational.
 */

const LABEL = 'block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground'

export function RegenerateSamplingRow({
  temperature,
  onTemperature,
  maxTokens,
  onMaxTokens,
}: {
  temperature: number
  onTemperature: (v: number) => void
  maxTokens: string
  onMaxTokens: (v: string) => void
}) {
  return (
    <div className="flex gap-3">
      <label className="flex-1">
        <span className={LABEL}>Temperature {temperature.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={temperature}
          onChange={e => onTemperature(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </label>
      <label className="w-28">
        <span className={LABEL}>Max tokens</span>
        <input
          type="number"
          min={256}
          value={maxTokens}
          onChange={e => onMaxTokens(e.target.value)}
          placeholder="32000"
          className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
        />
      </label>
    </div>
  )
}
