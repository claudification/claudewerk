import { useEffect, useState } from 'react'

interface VoiceDevicePickerProps {
  value: string
  onChange: (deviceId: string) => void
}

export function VoiceDevicePicker({ value, onChange }: VoiceDevicePickerProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    async function enumerate() {
      try {
        // Request mic permission first -- enumerateDevices returns empty labels
        // without a prior getUserMedia grant on most browsers.
        await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
          for (const t of s.getTracks()) t.stop()
        })
        const all = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setDevices(all.filter(d => d.kind === 'audioinput'))
        setError('')
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Cannot list devices')
      }
    }

    enumerate()

    // Re-enumerate when devices change (plug/unplug headphones)
    const handler = () => enumerate()
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', handler)
    }
  }, [])

  if (error) {
    return <span className="text-[10px] text-destructive font-mono">{error}</span>
  }

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
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
