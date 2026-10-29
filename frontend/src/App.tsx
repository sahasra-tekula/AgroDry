import { useCallback, useEffect, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowRight, Bell, Check, ChevronDown, Clock3,
  Cloud, Droplets, Gauge, Leaf, Menu, RefreshCw, Settings2, Thermometer, Wifi, WifiOff, X,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api, websocketUrl } from './api'
import { EmptyState, ErrorState, LoadingState } from './components/States'
import StatusBadge from './components/StatusBadge'
import { getSensorState } from './status'
import type { Alert, Device, LatestResponse, LiveMessage, Reading, SerialPort, Settings } from './types'

type Page = 'Overview' | 'Live monitoring' | 'Alerts' | 'Analytics' | 'Device settings'
type TimeRange = '24h' | '7d' | '30d'

const navigation: { name: Page; icon: typeof Activity }[] = [
  { name: 'Overview', icon: Activity },
  { name: 'Live monitoring', icon: Gauge },
  { name: 'Alerts', icon: Bell },
  { name: 'Analytics', icon: Cloud },
  { name: 'Device settings', icon: Settings2 },
]

const emptyLatest: LatestResponse = { reading: null, connection_status: 'disconnected', reading_count: 0 }

function rangeStart(range: TimeRange): Date {
  const start = new Date()
  start.setTime(start.getTime() - (range === '24h' ? 24 : range === '7d' ? 168 : 720) * 60 * 60 * 1000)
  return start
}

function formatTime(value?: string | null, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, options ?? { hour: 'numeric', minute: '2-digit' }).format(date)
}

function formatAge(value?: string | null): string {
  if (!value) return 'No readings yet'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (!Number.isFinite(seconds)) return 'No readings yet'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong while loading data.'
}

function toChartRows(readings: Reading[]) {
  const rows = readings.map((reading) => ({
    ...reading,
    label: formatTime(reading.timestamp, { hour: 'numeric', minute: '2-digit' }),
  }))
  return rows.flatMap((reading, index) => {
    const previous = rows[index - 1]
    if (!previous || Date.parse(reading.timestamp) - Date.parse(previous.timestamp) <= 10_000) {
      return [reading]
    }
    return [
      {
        ...reading,
        timestamp: new Date((Date.parse(previous.timestamp) + Date.parse(reading.timestamp)) / 2).toISOString(),
        temperature: null,
        humidity: null,
        status: 'gap',
        label: '',
      },
      reading,
    ]
  })
}

function App() {
  const [page, setPage] = useState<Page>('Overview')
  const [menuOpen, setMenuOpen] = useState(false)
  const [health, setHealth] = useState<'loading' | 'online' | 'offline'>('loading')
  const [socketConnected, setSocketConnected] = useState(false)
  const [device, setDevice] = useState<Device | null>(null)
  const [latest, setLatest] = useState<LatestResponse>(emptyLatest)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [ports, setPorts] = useState<SerialPort[]>([])
  const [selectedPort, setSelectedPort] = useState('')
  const [readings, setReadings] = useState<Reading[]>([])
  const [range, setRange] = useState<TimeRange>('24h')
  const [initialLoading, setInitialLoading] = useState(true)
  const [readingsLoading, setReadingsLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)

  const loadSnapshot = useCallback(async () => {
    const [healthResult, deviceResult, latestResult, alertsResult, settingsResult, portsResult] =
      await Promise.allSettled([
        api.health(), api.device(), api.latest(), api.alerts(), api.settings(), api.ports(),
      ])

    if (healthResult.status === 'fulfilled') setHealth('online')
    else setHealth('offline')
    if (deviceResult.status === 'fulfilled') setDevice(deviceResult.value)
    if (latestResult.status === 'fulfilled') setLatest(latestResult.value)
    if (alertsResult.status === 'fulfilled') setAlerts(alertsResult.value)
    if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value)
    if (portsResult.status === 'fulfilled') {
      setPorts(portsResult.value)
      setSelectedPort((current) => current || (settingsResult.status === 'fulfilled' ? settingsResult.value.port : '') || portsResult.value[0]?.device || '')
    }

    const failures = [deviceResult, latestResult, alertsResult, settingsResult]
      .filter((result) => result.status === 'rejected')
    if (failures.length) setDataError(messageOf((failures[0] as PromiseRejectedResult).reason))
    else setDataError('')
    setInitialLoading(false)
  }, [settings?.port])

  useEffect(() => {
    void loadSnapshot()
    const pollId = window.setInterval(() => {
      void Promise.allSettled([api.device(), api.latest(), api.alerts()]).then(([d, l, a]) => {
        if (d.status === 'fulfilled') setDevice(d.value)
        if (l.status === 'fulfilled') setLatest(l.value)
        if (a.status === 'fulfilled') setAlerts(a.value)
      })
    }, 20_000)
    return () => window.clearInterval(pollId)
  }, [loadSnapshot])

  useEffect(() => {
    let active = true
    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    const connect = () => {
      if (!active) return
      socket = new WebSocket(websocketUrl())
      socket.onopen = () => { if (active) setSocketConnected(true) }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as LiveMessage
          if (message.type !== 'update') return
          setLatest({ reading: message.reading, connection_status: message.connection_status, reading_count: message.reading_count })
          setDevice(message.device)
          setAlerts(message.alerts)
        } catch {
          // Ignore malformed frames; the REST snapshot remains authoritative.
        }
      }
      socket.onclose = () => {
        if (!active) return
        setSocketConnected(false)
        retryTimer = window.setTimeout(connect, 3000)
      }
      socket.onerror = () => socket?.close()
    }
    connect()
    return () => {
      active = false
      if (retryTimer) window.clearTimeout(retryTimer)
      socket?.close()
      setSocketConnected(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    setReadingsLoading(true)
    const end = new Date()
    api.readings(rangeStart(range).toISOString(), end.toISOString())
      .then((result) => { if (active) { setReadings(result); setDataError('') } })
      .catch((error: unknown) => { if (active) setDataError(messageOf(error)) })
      .finally(() => { if (active) setReadingsLoading(false) })
    return () => { active = false }
  }, [range])

  const sensorState = getSensorState(
    health === 'online' && socketConnected,
    latest.connection_status || device?.connection_status,
    latest.reading?.timestamp || device?.last_seen,
    settings?.stale_timeout_seconds ?? 300,
  )
  const latestReading = latest.reading
  const recentAlerts = alerts.length
  const warningReasons = latestReading?.status === 'warning'
    ? [
      latestReading.temperature !== null && settings && latestReading.temperature > settings.max_temperature
        ? `Temperature ${latestReading.temperature.toFixed(1)} °C is above the ${settings.max_temperature.toFixed(1)} °C limit`
        : null,
      latestReading.humidity !== null && settings && latestReading.humidity > settings.max_humidity
        ? `Humidity ${latestReading.humidity.toFixed(1)}% is above the ${settings.max_humidity.toFixed(1)}% limit`
        : null,
    ].filter((reason): reason is string => reason !== null)
    : []
  const systemStatus = sensorState === 'disconnected'
    ? 'DISCONNECTED'
    : sensorState === 'stale'
      ? 'STALE'
      : latestReading?.status === 'sensor_error'
        ? 'SENSOR ERROR'
        : latestReading?.status === 'warning'
          ? 'WARNING'
          : latestReading
            ? 'NORMAL'
            : 'WAITING'

  async function connectDevice() {
    if (!selectedPort) {
      setActionError('Choose an available serial port before connecting.')
      return
    }
    setActionLoading(true)
    setActionError('')
    setActionMessage('')
    try {
      await api.connect(selectedPort)
      setActionMessage(`Connection requested for ${selectedPort}.`)
      const nextDevice = await api.device()
      setDevice(nextDevice)
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setActionLoading(false)
    }
  }

  async function disconnectDevice() {
    setActionLoading(true)
    setActionError('')
    setActionMessage('')
    try {
      await api.disconnect()
      setActionMessage('Device disconnected.')
      const [nextDevice, nextLatest] = await Promise.all([api.device(), api.latest()])
      setDevice(nextDevice)
      setLatest(nextLatest)
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setActionLoading(false)
    }
  }

  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings) return
    const form = new FormData(event.currentTarget)
    const next: Settings = {
      max_temperature: Number(form.get('max_temperature')),
      max_humidity: Number(form.get('max_humidity')),
      stale_timeout_seconds: Number(form.get('stale_timeout_seconds')),
      port: settings.port,
    }
    setSettingsSaving(true)
    setActionError('')
    setActionMessage('')
    try {
      const saved = await api.updateSettings(next)
      setSettings(saved)
      setActionMessage('Threshold settings saved.')
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setSettingsSaving(false)
    }
  }

  return (
    <div className="app-shell">
      {menuOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Leaf size={21} fill="currentColor" /></div>
          <div><span className="brand-name">AgroDry</span><span className="brand-caption">FIELD INTELLIGENCE</span></div>
          <button className="icon-button mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={19} /></button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="farm-select">
          <span className="farm-icon"><Leaf size={17} /></span>
          <span className="min-w-0"><strong>North Field</strong><small>Sensor workspace</small></span>
          <ChevronDown size={15} className="ml-auto text-[#8b978c]" />
        </div>
        <div className="workspace-label nav-label">MONITORING</div>
        <nav className="nav-list" aria-label="Main navigation">
          {navigation.map(({ name, icon: Icon }) => (
            <button key={name} onClick={() => { setPage(name); setMenuOpen(false) }}
              className={`nav-item ${page === name ? 'nav-item-active' : ''}`} aria-current={page === name ? 'page' : undefined}>
              <Icon size={18} strokeWidth={1.9} /><span>{name}</span>
              {name === 'Alerts' && recentAlerts > 0 && <span className="nav-count">{recentAlerts}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-device">
            <div className={`device-avatar ${sensorState === 'live' ? 'device-avatar-live' : ''}`}><Wifi size={16} /></div>
            <div className="min-w-0"><strong>{device?.device_name || 'AgroDry Sensor'}</strong><small>{sensorState === 'live' ? 'Connected now' : sensorState === 'stale' ? 'No recent readings' : 'Not connected'}</small></div>
            <span className={`mini-dot mini-${sensorState}`} />
          </div>
          <div className="sidebar-foot"><span>AgroDry dashboard</span><span>v1.0</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
            <div className="breadcrumbs"><span>North Field</span><span className="crumb-slash">/</span><strong>{page}</strong></div>
          </div>
          <div className="topbar-right">
            <div className={`backend-indicator ${health === 'online' ? 'backend-online' : ''}`}>
              <span className="backend-dot" />{health === 'loading' ? 'Checking backend' : health === 'online' ? 'Backend connected' : 'Backend unavailable'}
            </div>
            <span className="topbar-separator" />
            <span className="today-label">{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</span>
            <div className="avatar">NF</div>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{page === 'Overview' ? 'FIELD OVERVIEW' : page.toUpperCase()}</p>
              <h1>{page === 'Overview' ? 'Good day, Field team' : page}</h1>
              <p className="page-subtitle">{page === 'Overview' ? 'Your crop environment, at a glance.' : page === 'Live monitoring' ? 'Track sensor readings and manage your serial connection.' : page === 'Alerts' ? 'Review threshold events reported by your sensor.' : page === 'Analytics' ? 'Explore recorded environmental readings over time.' : 'Configure alert thresholds and sensor freshness.'}</p>
            </div>
            <div className="heading-status"><StatusBadge state={sensorState} /><span className="updated-label"><Clock3 size={13} />{latestReading ? `Updated ${formatAge(latestReading.timestamp)}` : 'Awaiting first reading'}</span></div>
          </div>

          {(actionError || actionMessage) && (
            <div className={`notice ${actionError ? 'notice-error' : 'notice-success'}`} role={actionError ? 'alert' : 'status'}>
              {actionError ? <AlertTriangle size={17} /> : <Check size={17} />}
              <span>{actionError || actionMessage}</span>
              <button onClick={() => { setActionError(''); setActionMessage('') }} aria-label="Dismiss message"><X size={15} /></button>
            </div>
          )}

          {page === 'Overview' && (
            <Overview
              latest={latestReading}
              readingCount={latest.reading_count}
              recentAlerts={recentAlerts}
              systemStatus={systemStatus}
              warningReasons={warningReasons}
              sensorState={sensorState}
              device={device}
              readings={readings}
              loading={initialLoading || readingsLoading}
              error={dataError}
              range={range}
              onRange={setRange}
              onRetry={() => { void loadSnapshot() }}
            />
          )}
          {page === 'Live monitoring' && (
            <LiveMonitoring
              latest={latestReading}
              count={latest.reading_count}
              device={device}
              state={sensorState}
              ports={ports}
              selectedPort={selectedPort}
              setSelectedPort={setSelectedPort}
              onConnect={connectDevice}
              onDisconnect={disconnectDevice}
              actionLoading={actionLoading}
              socketConnected={socketConnected}
              loading={initialLoading}
              error={dataError}
            />
          )}
          {page === 'Alerts' && <AlertsPage alerts={alerts} loading={initialLoading} error={dataError} onRetry={() => { void loadSnapshot() }} />}
          {page === 'Analytics' && (
            <AnalyticsPage
              range={range}
              setRange={setRange}
              readings={readings}
              loading={readingsLoading}
              error={dataError}
            />
          )}
          {page === 'Device settings' && (
            <SettingsPage settings={settings} device={device} ports={ports} sensorState={sensorState}
              onSave={saveSettings} saving={settingsSaving} loading={initialLoading} />
          )}
          <footer className="page-footer"><span>AgroDry environmental monitoring</span><span>Data is reported by your connected sensor</span></footer>
        </div>
      </main>
    </div>
  )
}

function RangeControl({ range, onChange }: { range: TimeRange; onChange: (range: TimeRange) => void }) {
  return (
    <div className="range-control" role="group" aria-label="Chart time range">
      {(['24h', '7d', '30d'] as TimeRange[]).map((value) => (
        <button key={value} onClick={() => onChange(value)} className={range === value ? 'range-active' : ''} aria-pressed={range === value}>{value}</button>
      ))}
    </div>
  )
}

function MetricCard({ title, value, unit, icon: Icon, tone, note }: {
  title: string; value: string; unit?: string; icon: typeof Thermometer; tone: string; note: string
}) {
  return (
    <article className="metric-card">
      <div className="metric-top"><span className={`metric-icon ${tone}`}><Icon size={18} /></span><span className="metric-note">{note}</span></div>
      <div className="metric-value">{value}<span>{unit}</span></div>
      <div className="metric-title">{title}</div>
    </article>
  )
}

function ReadingsChart({ readings, compact = false }: { readings: Reading[]; compact?: boolean }) {
  const rows = toChartRows(readings)
  if (!rows.length) return <EmptyState title="No readings in this period" detail="Recorded sensor data will appear here when available." />
  return (
    <div className={compact ? 'chart-wrap chart-compact' : 'chart-wrap'}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 6, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="temperatureFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d99a55" stopOpacity={0.19} /><stop offset="95%" stopColor="#d99a55" stopOpacity={0} /></linearGradient>
            <linearGradient id="humidityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#63a3a0" stopOpacity={0.16} /><stop offset="95%" stopColor="#63a3a0" stopOpacity={0} /></linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#edf0eb" strokeDasharray="3 5" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#929c91', fontSize: 11 }} minTickGap={30} />
          <YAxis yAxisId="temp" axisLine={false} tickLine={false} tick={{ fill: '#929c91', fontSize: 11 }} width={43} />
          <YAxis yAxisId="humidity" orientation="right" axisLine={false} tickLine={false} tick={{ fill: '#929c91', fontSize: 11 }} width={36} domain={[0, 100]} />
          <Tooltip
            labelFormatter={(_, payload) => {
              const timestamp = payload[0]?.payload?.timestamp
              return timestamp
                ? formatTime(timestamp, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
                : 'No reading'
            }}
            contentStyle={{ border: '1px solid #e8ece6', borderRadius: 12, boxShadow: '0 10px 24px #26382c14', fontSize: 12 }}
            labelStyle={{ color: '#25372b', fontWeight: 700 }}
          />
          <Area yAxisId="temp" type="linear" dataKey="temperature" name="Temperature (°C)" stroke="#d6924c" strokeWidth={2.2} fill="url(#temperatureFill)" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} connectNulls={false} />
          <Area yAxisId="humidity" type="linear" dataKey="humidity" name="Humidity (%)" stroke="#5c9894" strokeWidth={2.2} fill="url(#humidityFill)" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} connectNulls={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function Overview({ latest, readingCount, recentAlerts, systemStatus, warningReasons, sensorState, device, readings, loading, error, range, onRange, onRetry }: {
  latest: Reading | null; readingCount: number; recentAlerts: number; systemStatus: string; warningReasons: string[]
  sensorState: 'live' | 'stale' | 'disconnected'
  device: Device | null; readings: Reading[]; loading: boolean; error: string; range: TimeRange
  onRange: (range: TimeRange) => void; onRetry: () => void
}) {
  return (
    <>
      <section className="metric-grid">
        <MetricCard title="Temperature" value={latest?.temperature == null ? '—' : latest.temperature.toFixed(1)} unit={latest?.temperature == null ? '' : '°C'} icon={Thermometer} tone="tone-amber" note={latest?.temperature == null ? 'No valid reading' : 'Latest reading'} />
        <MetricCard title="Relative humidity" value={latest?.humidity == null ? '—' : latest.humidity.toFixed(1)} unit={latest?.humidity == null ? '' : '%'} icon={Droplets} tone="tone-teal" note={latest?.humidity == null ? 'No valid reading' : 'Latest reading'} />
        <MetricCard title="System status" value={systemStatus} icon={systemStatus === 'NORMAL' ? Wifi : AlertTriangle} tone={systemStatus === 'NORMAL' ? 'tone-green' : systemStatus === 'WARNING' || systemStatus === 'STALE' ? 'tone-amber' : 'tone-neutral'} note={device?.sensor || 'Sensor'} />
        <MetricCard title="Recorded readings" value={readingCount.toLocaleString()} icon={Activity} tone="tone-purple" note="All time" />
      </section>

      <section className="overview-grid">
        <article className="panel chart-panel">
          <div className="panel-heading">
            <div><h2>Environmental trends</h2><p>Temperature and humidity recorded by your sensor</p></div>
            <RangeControl range={range} onChange={onRange} />
          </div>
          {loading && !readings.length ? <LoadingState label="Loading recorded readings…" /> : error && !readings.length ? <ErrorState message={error} onRetry={onRetry} /> : <ReadingsChart readings={readings} compact />}
          <div className="chart-legend"><span><i className="legend-temp" />Temperature <small>°C</small></span><span><i className="legend-hum" />Humidity <small>%</small></span><span className="legend-note">Historical data</span></div>
        </article>
        <article className="panel device-panel">
          <div className="panel-heading"><div><h2>Sensor connection</h2><p>Your field device</p></div><StatusBadge state={sensorState} compact /></div>
          <div className="device-illustration"><div className="sensor-orbit orbit-one" /><div className="sensor-orbit orbit-two" /><div className="sensor-tile"><Gauge size={27} /></div><span className={`sensor-pulse ${sensorState}`} /></div>
          <div className="device-name">{device?.device_name || 'AgroDry Sensor'}</div>
          <div className="device-meta">{device?.sensor || 'Sensor model unavailable'} <span>·</span> {device?.connection_type || 'Serial connection'}</div>
          <div className="device-details"><span>Port</span><strong>{device?.port || 'Not selected'}</strong><span>Last reading</span><strong>{latest ? formatTime(latest.timestamp) : 'No data yet'}</strong></div>
          <div className="connection-foot"><span className={`mini-dot mini-${sensorState}`} />{sensorState === 'live' ? 'Receiving sensor data' : sensorState === 'stale' ? 'Sensor data is overdue' : 'No active connection'}</div>
        </article>
      </section>
      {systemStatus === 'WARNING' && warningReasons.length > 0 && <div className="alert-strip"><AlertTriangle size={17} /><span><strong>Threshold warning</strong>: {warningReasons.join('; ')}.</span><ArrowRight size={16} /></div>}
      {systemStatus === 'SENSOR ERROR' && <div className="alert-strip"><AlertTriangle size={17} /><span><strong>Sensor error</strong>: the DHT22 did not return valid readings. Check the sensor wiring and connections.</span><ArrowRight size={16} /></div>}
      {recentAlerts > 0 && <div className="alert-strip"><Bell size={17} /><span><strong>{recentAlerts} recent alert event{recentAlerts === 1 ? '' : 's'}</strong> in the recorded history</span><ArrowRight size={16} /></div>}
    </>
  )
}

function LiveMonitoring({ latest, count, device, state, ports, selectedPort, setSelectedPort, onConnect, onDisconnect, actionLoading, socketConnected, loading, error }: {
  latest: Reading | null; count: number; device: Device | null; state: 'live' | 'stale' | 'disconnected'; ports: SerialPort[]
  selectedPort: string; setSelectedPort: (port: string) => void; onConnect: () => void; onDisconnect: () => void
  actionLoading: boolean; socketConnected: boolean; loading: boolean; error: string
}) {
  return (
    <div className="stack-layout">
      <section className="panel live-hero">
        <div className="live-main">
          <div className={`live-icon ${state}`}><Gauge size={29} /></div>
          <div><p className="eyebrow">SENSOR TELEMETRY</p><h2>{device?.device_name || 'AgroDry Sensor'}</h2><p>{device?.sensor || 'Sensor details are provided by the device API'}</p></div>
        </div>
        <StatusBadge state={state} />
      </section>
      <div className="live-grid">
        <section className="panel control-panel">
          <div className="panel-heading"><div><h2>Serial connection</h2><p>Select a port and manage the sensor connection.</p></div><span className={`backend-pill ${socketConnected ? 'backend-pill-on' : ''}`}><span />{socketConnected ? 'Stream connected' : 'Stream offline'}</span></div>
          {loading ? <LoadingState label="Checking device…" /> : error && !device ? <ErrorState message={error} /> : (
            <>
              <label className="field-label" htmlFor="serial-port">Available port</label>
              <div className="select-wrap">
                <select id="serial-port" value={selectedPort} onChange={(event) => setSelectedPort(event.target.value)}>
                  <option value="">Select a serial port</option>
                  {ports.map((port) => <option key={port.device} value={port.device}>{port.device}{port.description ? ` — ${port.description}` : ''}</option>)}
                </select><ChevronDown size={16} />
              </div>
              {!ports.length && <p className="field-hint">No ports were reported. Connect a serial device and refresh to check again.</p>}
              <div className="button-row">
                <button className="button-primary" onClick={onConnect} disabled={actionLoading || !selectedPort}><Wifi size={16} />{actionLoading ? 'Working…' : 'Connect device'}</button>
                <button className="button-secondary" onClick={onDisconnect} disabled={actionLoading || state === 'disconnected'}><WifiOff size={16} />Disconnect</button>
              </div>
              <p className="control-caption">Connection control is independent from threshold settings.</p>
            </>
          )}
        </section>
        <section className="panel live-state-panel">
          <div className="panel-heading"><div><h2>Current status</h2><p>Reported device and stream state</p></div><StatusBadge state={state} /></div>
          <div className="status-list">
            <div><span>Device connection</span><strong>{device?.connection_status || latest?.status || 'Unknown'}</strong></div>
            <div><span>Connection type</span><strong>{device?.connection_type || '—'}</strong></div>
            <div><span>Serial baud rate</span><strong>{device?.baud_rate ? `${device.baud_rate} baud` : '—'}</strong></div>
            <div><span>Last seen</span><strong>{formatTime(device?.last_seen || latest?.timestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}</strong></div>
            <div><span>Readings recorded</span><strong>{count.toLocaleString()}</strong></div>
          </div>
        </section>
      </div>
      <div className="live-reading-grid">
        <article className="panel reading-tile"><span className="reading-tile-label"><Thermometer size={16} />TEMPERATURE</span><strong>{latest?.temperature == null ? '—' : latest.temperature.toFixed(1)}<small>{latest?.temperature == null ? '' : '°C'}</small></strong><span>{latest ? formatTime(latest.timestamp) : 'Waiting for first reading'}</span></article>
        <article className="panel reading-tile"><span className="reading-tile-label"><Droplets size={16} />HUMIDITY</span><strong>{latest?.humidity == null ? '—' : latest.humidity.toFixed(1)}<small>{latest?.humidity == null ? '' : '%'}</small></strong><span>{latest ? formatTime(latest.timestamp) : 'Waiting for first reading'}</span></article>
        <article className="panel reading-tile"><span className="reading-tile-label"><Activity size={16} />STREAM</span><strong className="stream-value">{socketConnected ? 'Connected' : 'Offline'}</strong><span>WebSocket telemetry channel</span></article>
      </div>
    </div>
  )
}

function AlertsPage({ alerts, loading, error, onRetry }: { alerts: Alert[]; loading: boolean; error: string; onRetry: () => void }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading"><div><h2>Sensor alerts</h2><p>Threshold alerts received from the backend</p></div><div className="analytics-actions"><a className="button-secondary export-link" href="/api/export/alerts" download="agrodry-alerts.csv"><ArrowDownToLine size={16} />Export CSV</a><span className="alert-total">{alerts.length} total</span></div></div>
      {loading && !alerts.length ? <LoadingState label="Loading alerts…" /> : error && !alerts.length ? <ErrorState message={error} onRetry={onRetry} /> : alerts.length === 0 ? <EmptyState title="All clear" detail="No alerts have been reported by the sensor." /> : (
        <div className="table-scroll"><table><thead><tr><th>Severity</th><th>Measurement</th><th>Reading</th><th>Threshold</th><th>Reason</th><th>Time</th></tr></thead>
          <tbody>{alerts.map((alert) => <tr key={alert.id}><td><span className={`severity severity-${alert.severity.toLowerCase()}`}>{alert.severity}</span></td><td>{alert.measurement}</td><td className="table-value">{alert.value ?? '—'}</td><td>{alert.threshold ?? '—'}</td><td className="reason-cell">{alert.reason}</td><td>{formatTime(alert.timestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td></tr>)}</tbody>
        </table></div>
      )}
    </section>
  )
}

function AnalyticsPage({ range, setRange, readings, loading, error }: {
  range: TimeRange; setRange: (range: TimeRange) => void; readings: Reading[]; loading: boolean; error: string
}) {
  const temperatureReadings = readings.flatMap((row) => row.temperature === null ? [] : [row.temperature])
  const humidityReadings = readings.flatMap((row) => row.humidity === null ? [] : [row.humidity])
  const avgTemperature = temperatureReadings.length
    ? temperatureReadings.reduce((total, value) => total + value, 0) / temperatureReadings.length
    : null
  const avgHumidity = humidityReadings.length
    ? humidityReadings.reduce((total, value) => total + value, 0) / humidityReadings.length
    : null
  return (
    <div className="stack-layout">
      <section className="panel analytics-panel">
        <div className="panel-heading">
          <div><h2>Historical readings</h2><p>Only recorded sensor values are shown.</p></div>
          <div className="analytics-actions"><RangeControl range={range} onChange={setRange} />
            <a className="button-secondary export-link" href="/api/export/readings" download="agrodry-readings.csv"><ArrowDownToLine size={16} />Export CSV</a>
          </div>
        </div>
        {loading ? <LoadingState label="Loading historical readings…" /> : error && !readings.length ? <ErrorState message={error} /> : <ReadingsChart readings={readings} />}
      </section>
      <div className="analytics-summary">
        <article className="panel summary-card"><span>AVERAGE TEMPERATURE</span><strong>{avgTemperature === null ? '—' : `${avgTemperature.toFixed(1)} °C`}</strong><small>Across {readings.length.toLocaleString()} recorded samples</small></article>
        <article className="panel summary-card"><span>AVERAGE HUMIDITY</span><strong>{avgHumidity === null ? '—' : `${avgHumidity.toFixed(1)}%`}</strong><small>Across {readings.length.toLocaleString()} recorded samples</small></article>
        <article className="panel summary-card"><span>TIME WINDOW</span><strong>{range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days'}</strong><small>Based on backend timestamps</small></article>
      </div>
      <p className="analytics-note"><Clock3 size={14} />Chart values are retrieved from the readings API and reflect the selected time window.</p>
    </div>
  )
}

function SettingsPage({ settings, device, ports, sensorState, onSave, saving, loading }: {
  settings: Settings | null; device: Device | null; ports: SerialPort[]; sensorState: 'live' | 'stale' | 'disconnected'
  onSave: (event: React.FormEvent<HTMLFormElement>) => void; saving: boolean; loading: boolean
}) {
  return (
    <div className="settings-grid">
      <form className="panel settings-form" onSubmit={onSave}>
        <div className="panel-heading"><div><h2>Alert thresholds</h2><p>Set the maximum values for sensor alerts.</p></div><span className="settings-icon"><Settings2 size={18} /></span></div>
        {loading ? <LoadingState label="Loading settings…" /> : !settings ? <EmptyState title="Settings unavailable" detail="The backend has not returned threshold settings." /> : (
          <>
            <label className="settings-field"><span><Thermometer size={16} />Maximum temperature <small>Alert above this value</small></span><div className="input-unit"><input name="max_temperature" type="number" step="0.1" required defaultValue={settings.max_temperature} /><b>°C</b></div></label>
            <label className="settings-field"><span><Droplets size={16} />Maximum humidity <small>Alert above this value</small></span><div className="input-unit"><input name="max_humidity" type="number" step="0.1" min="0" max="100" required defaultValue={settings.max_humidity} /><b>%</b></div></label>
            <label className="settings-field"><span><Clock3 size={16} />Stale timeout <small>Mark readings stale after</small></span><div className="input-unit"><input name="stale_timeout_seconds" type="number" min="1" required defaultValue={settings.stale_timeout_seconds} /><b>sec</b></div></label>
            <div className="settings-submit"><span>Saving thresholds does not start or stop the device.</span><button className="button-primary" type="submit" disabled={saving}>{saving ? <RefreshCw size={15} className="animate-spin" /> : <Check size={15} />}{saving ? 'Saving…' : 'Save thresholds'}</button></div>
          </>
        )}
      </form>
      <section className="panel device-info-settings">
        <div className="panel-heading"><div><h2>Device information</h2><p>Connection details reported by your sensor</p></div></div>
        <div className="settings-device-header"><span className={`settings-device-icon ${sensorState}`}><Gauge size={21} /></span><div><strong>{device?.device_name || 'AgroDry Sensor'}</strong><small>{device?.sensor || 'Sensor not identified'}</small></div><StatusBadge state={sensorState} compact /></div>
        <div className="status-list settings-status">
          <div><span>Connection</span><strong>{device?.connection_type || '—'}</strong></div>
          <div><span>Current port</span><strong>{device?.port || settings?.port || 'Not configured'}</strong></div>
          <div><span>Baud rate</span><strong>{device?.baud_rate ? `${device.baud_rate} baud` : '—'}</strong></div>
          <div><span>Ports reported</span><strong>{ports.length}</strong></div>
          <div><span>Last seen</span><strong>{formatTime(device?.last_seen, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong></div>
        </div>
        <p className="settings-hint"><Wifi size={15} />To connect or disconnect the serial device, use <strong>Live monitoring</strong>. Connection control is intentionally separate from saving thresholds.</p>
      </section>
    </div>
  )
}

export default App
