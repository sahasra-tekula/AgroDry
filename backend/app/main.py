from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .evaluator import StatusEvaluator
from .models import DeviceConnectRequest, SettingsUpdate
from .serial_reader import SerialReader
from .storage import Storage

logging.basicConfig(level=os.getenv("AGRODRY_LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)
DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "agrodry.sqlite3"


class LiveHub:
    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: set[WebSocket] = set()

    def publish(self) -> None:
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(lambda: asyncio.create_task(self.broadcast()))

    async def broadcast(self) -> None:
        message = make_live_update(app.state.storage, app.state.evaluator, app.state.reader)
        disconnected: list[WebSocket] = []
        for client in tuple(self.clients):
            try:
                await client.send_json(message)
            except Exception:
                disconnected.append(client)
        for client in disconnected:
            self.clients.discard(client)


hub = LiveHub()


def connection_status(evaluator: StatusEvaluator, reader: SerialReader | None) -> str:
    is_open = bool(reader and reader.is_alive() and reader._serial is not None)
    return evaluator.connection_status(is_open)


def device_payload(storage: Storage, status: str) -> dict[str, Any]:
    settings = storage.settings()
    state = storage.device_state()
    return {
        "device_name": "AgroDry",
        "sensor": "DHT22",
        "connection_type": "USB Serial",
        "baud_rate": 115200,
        "port": settings.port,
        "connection_status": status,
        "last_seen": state["last_seen"],
    }


def make_live_update(storage: Storage, evaluator: StatusEvaluator, reader: SerialReader | None) -> dict[str, Any]:
    status = connection_status(evaluator, reader)
    reading = evaluator.latest_for_api(status)
    return {
        "type": "update",
        "reading": reading.model_dump(mode="json") if reading else None,
        "connection_status": status,
        "device": device_payload(storage, status),
        "reading_count": storage.count_readings(),
        "alerts": [item.model_dump(mode="json") for item in storage.alerts(limit=20)],
    }


@asynccontextmanager
async def lifespan(application: FastAPI):
    db_path = os.getenv("AGRODRY_DB_PATH", str(DEFAULT_DB))
    storage = Storage(db_path)
    configured_port = os.getenv("AGRODRY_PORT")
    if configured_port and not storage.settings().port:
        storage.update_settings(SettingsUpdate(port=configured_port))
    evaluator = StatusEvaluator(storage)
    application.state.storage = storage
    application.state.evaluator = evaluator
    hub.loop = asyncio.get_running_loop()
    reader = SerialReader(storage, evaluator, hub.publish, int(os.getenv("AGRODRY_BAUD_RATE", "115200")))
    application.state.reader = reader
    reader.start()
    try:
        yield
    finally:
        reader.stop()
        hub.loop = None


app = FastAPI(title="AgroDry API", version="1.0.0", lifespan=lifespan)
origins = [
    origin.strip() for origin in os.getenv(
        "AGRODRY_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",") if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def enumerate_serial_ports() -> list[dict[str, str]]:
    try:
        from serial.tools import list_ports

        return [
            {
                "port": item.device,
                "description": item.description or "",
                "hwid": item.hwid or "",
            }
            for item in list_ports.comports()
        ]
    except Exception as exc:
        logger.exception("Unable to enumerate serial ports")
        raise HTTPException(status_code=503, detail="Serial port enumeration is unavailable.") from exc


@app.get("/api/device/ports")
def get_device_ports() -> dict[str, Any]:
    return {"ports": enumerate_serial_ports()}


@app.post("/api/device/connect")
def connect_device(request: DeviceConnectRequest) -> dict[str, str]:
    port = request.port.strip()
    if not port:
        raise HTTPException(status_code=422, detail="A serial port is required.")
    if not any(item["port"] == port for item in enumerate_serial_ports()):
        raise HTTPException(status_code=400, detail=f"Serial port {port!r} is not currently available.")

    reader: SerialReader = app.state.reader
    old_port = app.state.storage.settings().port
    connected, error = reader.configure_port(port)
    if not connected:
        if old_port != port:
            reader.configure_port(old_port, timeout=3)
        raise HTTPException(status_code=503, detail=error or f"Unable to connect to serial port {port!r}.")
    hub.publish()
    return {"status": "connected", "port": port}


@app.post("/api/device/disconnect")
def disconnect_device() -> dict[str, str]:
    disconnected, error = app.state.reader.configure_port("")
    if not disconnected:
        raise HTTPException(status_code=503, detail=error or "Unable to disconnect the serial device.")
    hub.publish()
    return {"status": "disconnected", "port": ""}


@app.get("/api/device/status")
def get_device_status() -> dict[str, Any]:
    storage = app.state.storage
    status = connection_status(app.state.evaluator, app.state.reader)
    return device_payload(storage, status)


@app.get("/api/readings/latest")
def get_latest_reading() -> dict[str, Any]:
    storage = app.state.storage
    status = connection_status(app.state.evaluator, app.state.reader)
    reading = app.state.evaluator.latest_for_api(status)
    return {
        "reading": reading.model_dump(mode="json") if reading else None,
        "connection_status": status,
        "reading_count": storage.count_readings(),
    }


@app.get("/api/readings")
def get_readings(
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = Query(default=1000, ge=1, le=5000),
) -> list[dict[str, Any]]:
    for label, value in (("start", start), ("end", end)):
        if value is not None and value.utcoffset() is None:
            raise HTTPException(
                status_code=422,
                detail=f"{label} must include a timezone, for example a trailing Z.",
            )
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start must be earlier than or equal to end.")
    return [
        reading.model_dump(mode="json")
        for reading in app.state.storage.readings(limit, start, end)
    ]


@app.get("/api/alerts")
def get_alerts(limit: int = Query(default=1000, ge=1, le=5000)) -> list[dict[str, Any]]:
    return [alert.model_dump(mode="json") for alert in app.state.storage.alerts(limit)]


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return app.state.storage.settings().model_dump()


@app.put("/api/settings")
def put_settings(update: SettingsUpdate) -> dict[str, Any]:
    settings = app.state.storage.update_settings(update)
    hub.publish()
    return settings.model_dump()


def csv_response(table: str) -> StreamingResponse:
    rows = app.state.storage.export_rows(table)
    output = io.StringIO(newline="")
    columns = list(rows[0]) if rows else (
        ["id", "timestamp", "temperature", "humidity", "status"]
        if table == "readings"
        else ["id", "timestamp", "severity", "measurement", "value", "threshold", "reason"]
    )
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    writer.writerows(rows)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="agrodry-{table}.csv"'},
    )


@app.get("/api/export/readings")
@app.get("/api/exports/readings.csv")
def export_readings() -> StreamingResponse:
    return csv_response("readings")


@app.get("/api/export/alerts")
@app.get("/api/exports/alerts.csv")
def export_alerts() -> StreamingResponse:
    return csv_response("alerts")


@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket) -> None:
    await websocket.accept()
    hub.clients.add(websocket)
    try:
        await websocket.send_json(make_live_update(
            app.state.storage, app.state.evaluator, app.state.reader
        ))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(websocket)
