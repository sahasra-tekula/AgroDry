import type { SensorState } from './types'

export function getSensorState(
  backendConnected: boolean,
  deviceStatus: string | undefined,
  timestamp: string | null | undefined,
  staleTimeoutSeconds: number,
  now = Date.now(),
): SensorState {
  if (!backendConnected || !deviceStatus || /disconnect|offline|error|not connected/i.test(deviceStatus)) {
    return 'disconnected'
  }
  if (/stale|timeout|no data/i.test(deviceStatus)) return 'stale'
  if (!/connect|online|live|ready|active/i.test(deviceStatus)) return 'disconnected'
  if (!timestamp) return 'stale'

  const readingTime = new Date(timestamp).getTime()
  if (!Number.isFinite(readingTime) || now - readingTime > staleTimeoutSeconds * 1000 || readingTime - now > 60_000) {
    return 'stale'
  }
  return 'live'
}

export function stateLabel(state: SensorState): string {
  return state === 'live' ? 'LIVE' : state === 'stale' ? 'STALE' : 'DISCONNECTED'
}
