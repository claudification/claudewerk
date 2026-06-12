// Transient "message in flight" edge: a glowing dot travels the bezier from
// sender card to receiver card when an inter-conversation send is observed.
// use-message-pulses mounts one of these per live pulse and retires it.
import { BaseEdge, type EdgeProps, getBezierPath } from '@xyflow/react'

const PULSE_DURATION_S = 1.6

export function PulseEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const queued = data?.status === 'queued'
  const color = queued ? 'var(--color-idle)' : 'var(--color-info)'
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{ stroke: color, strokeWidth: 1.5, opacity: 0.5, strokeDasharray: '4 6' }}
      />
      <circle r={5} fill={color} style={{ filter: `drop-shadow(0 0 6px ${color})` }}>
        <animateMotion dur={`${PULSE_DURATION_S}s`} repeatCount="1" fill="freeze" path={path} />
      </circle>
    </>
  )
}
