from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.main import app
from app.models import Reading


def test_rest_contract_defaults_and_settings_update(tmp_path, monkeypatch):
    monkeypatch.setenv("AGRODRY_DB_PATH", str(tmp_path / "api.sqlite3"))
    monkeypatch.delenv("AGRODRY_PORT", raising=False)
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        settings_response = client.get("/api/settings")
        assert settings_response.status_code == 200
        assert settings_response.json()["max_temperature"] == 40
        assert settings_response.json()["max_humidity"] == 65
        assert client.put("/api/settings", json={"max_humidity": 68, "port": ""}).json()[
            "max_humidity"
        ] == 68
        assert client.get("/api/device/status").json()["connection_status"] == "disconnected"
        latest = client.get("/api/readings/latest").json()
        assert latest == {"reading": None, "connection_status": "disconnected", "reading_count": 0}
        assert client.get("/api/readings").json() == []
        assert client.get("/api/alerts").json() == []


def test_websocket_starts_with_contract_update(tmp_path, monkeypatch):
    monkeypatch.setenv("AGRODRY_DB_PATH", str(tmp_path / "ws.sqlite3"))
    monkeypatch.delenv("AGRODRY_PORT", raising=False)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/live") as websocket:
            message = websocket.receive_json()
            assert message["type"] == "update"
            assert set(("reading", "connection_status", "device", "reading_count", "alerts")) <= set(message)


def test_serial_port_controls_and_explicit_errors(tmp_path, monkeypatch):
    monkeypatch.setenv("AGRODRY_DB_PATH", str(tmp_path / "ports.sqlite3"))
    monkeypatch.delenv("AGRODRY_PORT", raising=False)
    monkeypatch.setattr("app.main.enumerate_serial_ports", lambda: [
        {"port": "COM7", "description": "USB Serial", "hwid": "test"}
    ])
    with TestClient(app) as client:
        reader = app.state.reader
        monkeypatch.setattr(reader, "configure_port", lambda port, timeout=6: (True, None))
        assert client.get("/api/device/ports").json()["ports"][0]["port"] == "COM7"
        assert client.post("/api/device/connect", json={"port": "COM7"}).json() == {
            "status": "connected", "port": "COM7"
        }
        assert client.post("/api/device/disconnect").json() == {
            "status": "disconnected", "port": ""
        }
        unavailable = client.post("/api/device/connect", json={"port": "COM8"})
        assert unavailable.status_code == 400
        assert "not currently available" in unavailable.json()["detail"]


def test_serial_open_failure_returns_clear_error(tmp_path, monkeypatch):
    monkeypatch.setenv("AGRODRY_DB_PATH", str(tmp_path / "ports-error.sqlite3"))
    monkeypatch.delenv("AGRODRY_PORT", raising=False)
    monkeypatch.setattr("app.main.enumerate_serial_ports", lambda: [
        {"port": "COM7", "description": "USB Serial", "hwid": "test"}
    ])
    with TestClient(app) as client:
        reader = app.state.reader
        results = iter([(False, "Port is in use."), (True, None)])
        monkeypatch.setattr(reader, "configure_port", lambda port, timeout=6: next(results))
        response = client.post("/api/device/connect", json={"port": "COM7"})
        assert response.status_code == 503
        assert response.json()["detail"] == "Port is in use."


def test_reading_time_range_and_csv_exports(tmp_path, monkeypatch):
    monkeypatch.setenv("AGRODRY_DB_PATH", str(tmp_path / "history.sqlite3"))
    monkeypatch.delenv("AGRODRY_PORT", raising=False)
    with TestClient(app) as client:
        storage = app.state.storage
        storage.record_reading(Reading(
            timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
            temperature=21.5,
            humidity=55,
            status="normal",
        ))
        storage.record_reading(Reading(
            timestamp=datetime(2026, 1, 2, tzinfo=timezone.utc),
            temperature=41,
            humidity=70,
            status="warning",
        ))
        ranged = client.get(
            "/api/readings",
            params={"start": "2026-01-02T00:00:00Z", "end": "2026-01-02T00:00:00Z"},
        )
        assert ranged.status_code == 200
        assert len(ranged.json()) == 1
        assert ranged.json()[0]["temperature"] == 41
        assert client.get(
            "/api/readings",
            params={"start": "2026-01-02T00:00:00", "end": "2026-01-03T00:00:00Z"},
        ).status_code == 422
        assert client.get(
            "/api/readings",
            params={"start": "2026-01-03T00:00:00Z", "end": "2026-01-02T00:00:00Z"},
        ).status_code == 422
        assert "21.5" in client.get("/api/export/readings").text
        assert "Temperature exceeded" not in client.get("/api/export/alerts").text
