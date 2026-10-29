import { Radio, Signal, SignalZero } from 'lucide-react'
import type { SensorState } from '../types'
import { stateLabel } from '../status'

const icons = {
  live: Radio,
  stale: Signal,
  disconnected: SignalZero,
}

export default function StatusBadge({ state, compact = false }: { state: SensorState; compact?: boolean }) {
  const Icon = icons[state]
  return (
    <span className={`status-badge status-${state}`} role="status" aria-label={`Sensor status: ${stateLabel(state)}`}>
      <Icon size={14} strokeWidth={2.2} />
      {!compact && stateLabel(state)}
    </span>
  )
}
