/**
 * The header's second hand. Its own component so a per-second tick re-renders
 * eight characters instead of the whole header bar.
 */

import { useEffect, useState } from 'react'

function nowLabel(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

export function WallClock() {
  const [time, setTime] = useState(nowLabel)
  useEffect(() => {
    const timer = setInterval(() => setTime(nowLabel()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="wall-clock">{time}</span>
}
