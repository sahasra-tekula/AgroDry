export interface Reading {
  timestamp: string
  temperature: number | null
  humidity: number | null
  status: string
}

export interface Device {
  device_name: string
  sensor: string
  connection_type: string
  baud_rate: number
  port: string
  connection_status: string
  last_seen: string | null
}

export interface LatestResponse {
  reading: Reading | null
  connection_status: string
  reading_count: number
}

export interface Alert {
  id: string | number
  timestamp: string
  severity: string
  measurement: string
  value: number | null
  threshold: number | null
  reason: string
}

export interface Settings {
  max_temperature: number
  max_humidity: number
  stale_timeout_seconds: number
  port: string
}

export interface SerialPort {
  device: string
  description?: string
  hwid?: string
  [key: string]: unknown
}

export interface LiveMessage {
  type: 'update'
  reading: Reading | null
  connection_status: string
  device: Device
  reading_count: number
  alerts: Alert[]
}

export type SensorState = 'live' | 'stale' | 'disconnected'
