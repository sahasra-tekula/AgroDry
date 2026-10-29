import csv
import io
import asyncio
from types import SimpleNamespace

from app.main import csv_response
from app.models import Reading
from app.storage import Storage
from datetime import datetime, timezone


def test_readings_csv_export_has_headers_and_data(tmp_path, monkeypatch):
    storage = Storage(tmp_path / "store.sqlite3")
    storage.record_reading(Reading(
        timestamp=datetime.now(timezone.utc), temperature=24, humidity=50, status="normal"
    ))
    monkeypatch.setattr("app.main.app.state", SimpleNamespace(storage=storage))
    response = csv_response("readings")
    chunk = asyncio.run(response.body_iterator.__anext__())
    rows = list(csv.DictReader(io.StringIO(chunk)))
    assert rows[0]["temperature"] == "24.0"
    assert rows[0]["humidity"] == "50.0"


def test_empty_alert_export_has_headers(tmp_path, monkeypatch):
    storage = Storage(tmp_path / "store.sqlite3")
    monkeypatch.setattr("app.main.app.state", SimpleNamespace(storage=storage))
    response = csv_response("alerts")
    chunk = asyncio.run(response.body_iterator.__anext__())
    rows = list(csv.reader(io.StringIO(chunk)))
    assert rows[0] == ["id", "timestamp", "severity", "measurement", "value", "threshold", "reason"]
