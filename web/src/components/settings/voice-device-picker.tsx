import { useCallback, useEffect, useRef, useState } from 'react'
import { isPinnableDevice, openPreferredMicStream } from '@/hooks/voice-mic-stream'

interface VoiceDevicePickerProps {
  value: string
  onChange: (deviceId: string) => void
}

/**
 * Heal a previously-saved virtual id ('default'/'communications') to the real
 * device behind it (same groupId), so an existing bad pick stops tracking the OS
 * default without the user re-selecting. No-op unless it resolves uniquely.
 */
function healVirtualSelection(
  inputs: MediaDeviceInfo[],
  real: MediaDeviceInfo[],
  saved: string,
  onChange: (deviceId: string) => void,
) {
  if (!saved || isPinnableDevice(saved)) return
  const virtual = inputs.find(d => d.deviceId === saved)
  if (!virtual?.groupId) return
  const match = real.filter(d => d.groupId === virtual.groupId)
  if (match.length === 1) onChange(match[0].deviceId)
}

export function VoiceDevicePicker({ value, onChange }: VoiceDevicePickerProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')
  // react-doctor:rerender-state-only-in-handlers -- labelsHidden is read in JSX
  // (onMouseDown/onFocus conditionals), so it must be state to drive re-renders.
  const [labelsHidden, setLabelsHidden] = useState(false)
  const enumeratingRef = useRef(false)
  // Latest `value` without making `enumerate` re-created on every keystroke.
  const valueRef = useRef(value)
  valueRef.current = value

  // `unlock` opens the preferred mic once to reveal labels (browsers hide them
  // without a persistent grant). On mount we DON'T unlock -- on a standing grant
  // (desktop Chrome) labels are already there, so the saved pick shows on open
  // with zero Bluetooth blip; only first-run (no grant) needs the unlock.
  const enumerate = useCallback(
    async (unlock: boolean) => {
      if (enumeratingRef.current) return
      enumeratingRef.current = true
      try {
        if (unlock) {
          const s = await openPreferredMicStream()
          for (const t of s.getTracks()) t.stop()
        }
        const all = await navigator.mediaDevices.enumerateDevices()
        const inputs = all.filter(d => d.kind === 'audioinput')
        // Drop Chrome's virtual "Default"/"Communications" rows: their deviceId
        // follows the OS default, so pinning one yanks a Bluetooth headset into
        // HFP the moment it connects. Only real hardware ids pin a fixed mic.
        const real = inputs.filter(d => isPinnableDevice(d.deviceId))
        healVirtualSelection(inputs, real, valueRef.current, onChange)
        // Labels are blank until a grant exists -- if so, keep prompting an unlock.
        setLabelsHidden(real.length > 0 && !real.some(d => d.label))
        setDevices(real)
        setError('')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Cannot list devices')
      } finally {
        enumeratingRef.current = false
      }
    },
    [onChange],
  )

  // Enumerate on mount (no mic opened) so the saved selection shows immediately,
  // and re-enumerate on device plug/unplug.
  useEffect(() => {
    enumerate(false)
    const handler = () => enumerate(false)
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
  }, [enumerate])

  if (error) {
    return <span className="text-[10px] text-destructive font-mono">{error}</span>
  }

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      // Only when labels are still hidden (no grant yet) does the first
      // interaction open the preferred mic once to reveal them.
      onMouseDown={labelsHidden ? () => enumerate(true) : undefined}
      onFocus={labelsHidden ? () => enumerate(true) : undefined}
      className="w-52 bg-muted border border-border text-foreground text-xs px-2 py-1 font-mono truncate"
    >
      <option value="">System default</option>
      {devices.map(d => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `Device ${d.deviceId.slice(0, 8)}`}
        </option>
      ))}
    </select>
  )
}
