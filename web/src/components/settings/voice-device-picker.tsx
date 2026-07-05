import { useCallback, useEffect, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isPinnableDevice, openPreferredMicStream } from '@/hooks/voice-mic-stream'

interface VoiceDevicePickerProps {
  value: string
  /** Last-known label for `value` (persisted). Shows the right mic name at mount,
   *  before enumeration/labels land -- so the trigger never lies about the pick. */
  label: string
  /** Fires with the resolved (id, label). id only changes on a real user pick;
   *  a same-id call is just a label refresh (caller must NOT re-acquire the mic). */
  onChange: (deviceId: string, label: string) => void
}

// Radix Select forbids an empty-string item value; '' (System default) maps to
// this sentinel at the value/onValueChange boundary (see gotchas-frontend.md).
const DEFAULT_SENTINEL = '__default__'

type OnChange = (deviceId: string, label: string) => void

/** Open the preferred mic once and drop it -- reveals device labels a browser
 *  hides until a grant exists. */
async function revealLabels() {
  const s = await openPreferredMicStream()
  for (const t of s.getTracks()) t.stop()
}

/**
 * Heal a previously-saved virtual id ('default'/'communications') to the real
 * device behind it (same groupId), so an existing bad pick stops tracking the OS
 * default without the user re-selecting. No-op unless it resolves uniquely.
 */
function healVirtualSelection(inputs: MediaDeviceInfo[], real: MediaDeviceInfo[], saved: string, onChange: OnChange) {
  if (!saved || isPinnableDevice(saved)) return
  const virtual = inputs.find(d => d.deviceId === saved)
  if (!virtual?.groupId) return
  const match = real.filter(d => d.groupId === virtual.groupId)
  if (match.length === 1) onChange(match[0].deviceId, match[0].label || '')
}

/**
 * Cache the saved real device's live label so future mounts (even with no grant,
 * where `real` is empty) render the right name in the trigger. Fires with the
 * SAME id -- a label refresh, never a device switch.
 */
function cacheSelectedLabel(real: MediaDeviceInfo[], saved: string, savedLabel: string, onChange: OnChange) {
  if (!saved || !isPinnableDevice(saved)) return
  const sel = real.find(d => d.deviceId === saved)
  if (sel?.label && sel.label !== savedLabel) onChange(sel.deviceId, sel.label)
}

export function VoiceDevicePicker({ value, label, onChange }: VoiceDevicePickerProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')
  // Labels are hidden until a mic grant exists; drives the first-interaction unlock.
  const [labelsHidden, setLabelsHidden] = useState(false)
  const enumeratingRef = useRef(false)
  // Latest value/label/onChange behind refs so `enumerate` stays stable -- the
  // mount effect must fire ONCE, not on every render (onChange is an inline arrow
  // recreated each render, which would otherwise re-run enumeration forever).
  const valueRef = useRef(value)
  valueRef.current = value
  const labelRef = useRef(label)
  labelRef.current = label
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // `unlock` opens the preferred mic once to reveal labels (browsers hide them
  // without a persistent grant). On mount we DON'T unlock -- on a standing grant
  // (desktop Chrome) labels are already there; only first-run (no grant) unlocks.
  const enumerate = useCallback(
    async (unlock: boolean) => {
      if (enumeratingRef.current) return
      enumeratingRef.current = true
      try {
        if (unlock) await revealLabels()
        const all = await navigator.mediaDevices.enumerateDevices()
        const inputs = all.filter(d => d.kind === 'audioinput')
        // Drop Chrome's virtual "Default"/"Communications" rows: their deviceId
        // follows the OS default, so pinning one yanks a Bluetooth headset into
        // HFP the moment it connects. Only real hardware ids pin a fixed mic.
        const real = inputs.filter(d => isPinnableDevice(d.deviceId))
        healVirtualSelection(inputs, real, valueRef.current, onChangeRef.current)
        cacheSelectedLabel(real, valueRef.current, labelRef.current, onChangeRef.current)
        // No grant yet -> blank ids + labels -> `real` empty. Gate the unlock on
        // `inputs` (present even without a grant), NOT `real`.
        setLabelsHidden(inputs.length > 0 && !real.some(d => d.label))
        setDevices(real)
        setError('')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Cannot list devices')
      } finally {
        enumeratingRef.current = false
      }
    },
    [],
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

  const selectValue = value ? value : DEFAULT_SENTINEL
  // The saved mic isn't in the live list yet (no grant, still enumerating, or
  // unplugged). Inject a synthetic item so the trigger renders the saved name
  // instead of reverting to "System default" -- the core "keeps its state" fix.
  const savedMissing = !!value && !devices.some(d => d.deviceId === value)

  return (
    <Select
      value={selectValue}
      onValueChange={v => {
        const id = v === DEFAULT_SENTINEL ? '' : v
        const picked = devices.find(d => d.deviceId === id)
        onChange(id, picked?.label || (id === value ? label : ''))
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-52 text-xs"
        // Only when labels are still hidden (no grant) does opening the picker
        // open the preferred mic once to reveal them.
        onPointerDown={labelsHidden ? () => enumerate(true) : undefined}
      >
        <SelectValue placeholder="System default" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_SENTINEL}>System default</SelectItem>
        {savedMissing && <SelectItem value={value}>{label || 'Saved microphone'}</SelectItem>}
        {devices.map(d => (
          <SelectItem key={d.deviceId} value={d.deviceId}>
            {d.label || `Device ${d.deviceId.slice(0, 8)}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
