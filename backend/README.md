# AgroDry backend

FastAPI service that reads the device's USB serial stream, persists genuine sensor events/settings in SQLite, and serves the monitoring API and live WebSocket. The only readings stored are complete device reports; an unconfigured or disconnected device is never replaced with simulated data.

## Run

From `backend/`:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:AGRODRY_PORT = "COM3"  # Set to the board's actual port; omit to stay disconnected.
uvicorn app.main:app --reload
```

The API is at `http://localhost:8000`; Vite origins `localhost:5173` and `127.0.0.1:5173` are enabled by default. Configuration: `AGRODRY_PORT`, `AGRODRY_BAUD_RATE` (115200), `AGRODRY_DB_PATH`, `AGRODRY_CORS_ORIGINS` (comma-separated), and `AGRODRY_LOG_LEVEL`.

The parser accepts one JSON object per line (`temperature`, `humidity`, `status`) from `firmware/AgroDry.ino`, and can also parse the legacy text format retained in `firmware/original_backup.ino`. JSON `status: "SENSOR_ERROR"` creates a null-valued sensor-error event rather than a fabricated measurement. Backend defaults are 40 °C and 65% RH; the firmware does not set or override backend thresholds.

Endpoints include `/api/health`, `/api/device/status`, `/api/device/ports`, `/api/device/connect`, `/api/device/disconnect`, `/api/readings`, `/api/readings/latest`, `/api/alerts`, `/api/settings`, and `/ws/live`. CSV exports are available at `/api/export/readings` and `/api/export/alerts` (also `/api/exports/readings.csv` and `/api/exports/alerts.csv`). Connect accepts `{"port":"COM3"}` and connects only to a currently enumerated port; the single reader thread is the sole serial-port owner. Missing ports and serial open failures return explicit HTTP errors. Reading history accepts optional timezone-aware ISO `start` and `end` filters; reading and alert list endpoints accept an optional bounded `limit`.

## Tests

```powershell
pytest
```
