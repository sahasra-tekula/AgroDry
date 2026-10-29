import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import StatusBadge from './components/StatusBadge'
import { ErrorState } from './components/States'
import { getSensorState } from './status'

describe('sensor status', () => {
  const now = Date.parse('2026-10-29T12:00:00Z')

  it('only reports live when the backend and device are connected and the sample is fresh', () => {
    expect(getSensorState(true, 'connected', '2026-10-29T11:59:30Z', 300, now)).toBe('live')
    expect(getSensorState(false, 'connected', '2026-10-29T11:59:30Z', 300, now)).toBe('disconnected')
  })

  it('distinguishes stale readings from disconnected devices', () => {
    expect(getSensorState(true, 'connected', '2026-10-29T11:50:00Z', 300, now)).toBe('stale')
    expect(getSensorState(true, 'disconnected', '2026-10-29T11:59:30Z', 300, now)).toBe('disconnected')
    expect(getSensorState(true, 'connected', null, 300, now)).toBe('stale')
  })

  it('renders an accessible status label', () => {
    render(<StatusBadge state="stale" />)
    expect(screen.getByRole('status', { name: 'Sensor status: STALE' })).toBeInTheDocument()
  })
})

describe('error state', () => {
  it('shows the request error and exposes retry', () => {
    const retry = vi.fn()
    render(<ErrorState message="Request failed (503)" onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed (503)')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
