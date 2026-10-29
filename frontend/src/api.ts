import type { Alert, Device, LatestResponse, Reading, SerialPort, Settings } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function normalizePorts(value: unknown): SerialPort[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && 'ports' in value && Array.isArray(value.ports)
      ? value.ports
      : []
  return rows.flatMap((item): SerialPort[] => {
    if (typeof item === 'string') return [{ device: item }]
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const device = row.device ?? row.port ?? row.name
    if (typeof device !== 'string') return []
    const description = typeof row.description === 'string' ? row.description : undefined
    return [{ ...row, device, description }]
  })
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),
  device: () => request<Device>('/api/device/status'),
  latest: () => request<LatestResponse>('/api/readings/latest'),
  readings: (start: string, end: string) =>
    request<Reading[]>(`/api/readings?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  alerts: () => request<Alert[]>('/api/alerts'),
  settings: () => request<Settings>('/api/settings'),
  updateSettings: (settings: Settings) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  ports: async () => normalizePorts(await request<unknown>('/api/device/ports')),
  connect: (port: string) =>
    request<unknown>('/api/device/connect', { method: 'POST', body: JSON.stringify({ port }) }),
  disconnect: () =>
    request<unknown>('/api/device/disconnect', { method: 'POST' }),
}

export function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/live`
}
