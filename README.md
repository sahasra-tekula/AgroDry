# AgroDry — Smart Dryer Monitoring System

AgroDry monitors the air temperature and relative humidity around grain using
an ESP32 DevKit V1 and a DHT22 sensor. The ESP32 sends readings over USB
serial; a local FastAPI service stores and broadcasts them, and a React
dashboard displays live status and history.

> **Scope:** This demonstration measures environmental air. It does not measure
> internal grain moisture, determine whether grain is spoiled, or control a
> dryer. The default thresholds (40.0 °C and 65.0% RH) are configurable
> demonstration settings, not universal agricultural safety limits.

## Architecture

```text
ESP32 + DHT22 --USB serial/JSON lines--> FastAPI serial reader
                                             | SQLite
                                             | REST + WebSocket
                                             v
                                      React + Vite dashboard
```

- `firmware/AgroDry.ino` reads the DHT22 on GPIO 4 at 115200 baud and emits
  one JSON object per line. Valid messages contain `temperature`, `humidity`,
  and `"status":"OK"`; sensor failures are emitted as `"status":"SENSOR_ERROR"`.
- `firmware/original_backup.ino` is the unchanged sketch as found before the
  JSON serial-format change.
- `backend/` owns the USB port, validates messages, timestamps readings on
  receipt, persists actual readings and alert transitions to SQLite, and
  serves the API and live WebSocket.
- `frontend/` is the Vite dashboard. In development, Vite proxies `/api` and
  `/ws` to the local backend.

There is no live-data simulation mode. Tests may use sample messages in
isolation, but test data is never presented or stored as a real device reading.
The dashboard must not be described as LIVE unless the real serial device is
connected and producing fresh readings.

## Prerequisites

- Windows 10/11.
- Python 3.11 or later.
- Node.js LTS with npm.
- Arduino IDE 2.x (or Arduino CLI) and the ESP32 board support package.
- USB data cable and the DHT library compatible with the sketch (`DHT sensor
  library` by Adafruit; install its required Adafruit Unified Sensor library
  when prompted).

## Hardware and firmware

| DHT22 | ESP32 DevKit V1 |
|---|---|
| VCC | 3V3 |
| DATA | GPIO 4 |
| GND | GND |

1. Open `firmware/AgroDry.ino` in Arduino IDE, select the ESP32 DevKit V1 board
   and its COM port, then upload the sketch if the board does not already have
   it.
2. Find the assigned port in **Device Manager → Ports (COM & LPT)** or in
   Arduino IDE's port menu.
3. **Close Serial Monitor and Serial Plotter before connecting from AgroDry.**
   Windows serial ports can be owned by only one application at a time.

The firmware change is limited to serial output: human-readable multi-line
messages and firmware-side threshold checks were replaced with one JSON object
per sample. Threshold evaluation belongs to the backend so the configured
limits have one source of truth. Sensor wiring and two-second sampling remain
unchanged. The pre-existing sketch used a 75.0% humidity threshold; the
requested application default is 65.0% and is applied by the backend.

## Run locally

Open two VS Code terminals at the project root.

### Backend terminal

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

If PowerShell blocks activation for this terminal, run
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` and activate again.
The backend API is at `http://127.0.0.1:8000`; its interactive API
documentation is at `http://127.0.0.1:8000/docs`.

### Frontend terminal

```powershell
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). Use the
dashboard's device controls to select the ESP32 COM port and connect. A sensor
error, disconnected port, or stale data is reported distinctly; a reading is
not fabricated when the device is unavailable.

## API

The local API provides `GET /api/health`, device status and port controls,
latest readings, timestamp-filtered `GET /api/readings?start=...&end=...`,
alerts, persistent threshold settings, `GET /api/export/readings`,
`GET /api/export/alerts`, and `/ws/live` updates. Use ISO 8601 timestamps with
time zones for the optional `start` and `end` filters. See the FastAPI
documentation at `/docs` for the implemented request and response schemas.

## Tests

Run backend tests from the `backend` directory:

```powershell
python -m pytest
```

Run frontend tests from the `frontend` directory:

```powershell
npm test
```

Create a production frontend build with:

```powershell
npm run build
```

Tests use isolated fixtures and do not require a connected ESP32. A dashboard
with no selected serial device is a disconnected live-data view, not a
simulation.

## Troubleshooting

- **Port is busy / access denied:** close Arduino Serial Monitor/Plotter and
  any other terminal connected to the ESP32, then reconnect.
- **No COM port listed:** use a USB data cable, reconnect the board, check
  Device Manager, and install the board's USB-to-serial driver if necessary.
- **Sensor error:** verify GPIO 4, 3V3, and GND; check the DHT22 pin orientation
  and allow the sensor to settle after power-up.
- **Dashboard cannot reach API:** start the backend first and check
  `http://127.0.0.1:8000/api/health`; then reload the Vite page.
- **Stale/disconnected state:** check the USB cable and selected COM port.
  The backend adds receipt timestamps and does not treat an old reading as
  fresh.
- **Threshold alert:** review the configured limits and measured values.
  Thresholds are demonstration controls only and are not a grain-safety
  diagnosis.

## Project walkthrough

For a college review, trace one reading through these steps:

1. `firmware/AgroDry.ino`: acquire temperature/humidity and emit the JSON line.
2. `backend/app/serial_reader.py`: own the serial connection, parse and
   validate the line, and timestamp accepted readings.
3. `backend/app/evaluator.py`: compare valid data against persisted thresholds
   and classify connection, stale, sensor-error, normal, or warning states.
4. `backend/app/storage.py`: persist readings, settings, and meaningful alert
   transitions in SQLite.
5. `backend/app/main.py`: expose readings and status via REST,
   plus updates over WebSocket.
6. `frontend/src/`: fetch API data, subscribe to live events, and render
   status, trends, alerts, and device settings.
