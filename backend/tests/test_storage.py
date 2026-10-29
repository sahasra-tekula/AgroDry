from datetime import datetime, timezone

from app.models import Reading, SettingsUpdate
from app.storage import Storage


def test_default_settings_and_partial_update_persist(tmp_path):
    database = tmp_path / "store.sqlite3"
    storage = Storage(database)
    defaults = storage.settings()
    assert defaults.max_temperature == 40
    assert defaults.max_humidity == 65
    updated = storage.update_settings(SettingsUpdate(port="COM8", max_humidity=70))
    assert updated.port == "COM8"
    assert updated.max_humidity == 70
    assert Storage(database).settings() == updated


def test_readings_and_exports_are_persisted_in_chronological_order(tmp_path):
    storage = Storage(tmp_path / "store.sqlite3")
    for temp in (24.0, 25.0):
        storage.record_reading(Reading(
            timestamp=datetime.now(timezone.utc), temperature=temp, humidity=50, status="normal"
        ))
    assert [r.temperature for r in storage.readings()] == [24, 25]
    rows = storage.export_rows("readings")
    assert len(rows) == 2
    assert rows[0]["status"] == "normal"
    assert storage.count_readings() == 2


def test_export_rejects_unexpected_table(tmp_path):
    storage = Storage(tmp_path / "store.sqlite3")
    try:
        storage.export_rows("settings")
    except ValueError as exc:
        assert "Unsupported export" in str(exc)
    else:
        raise AssertionError("Unexpected export table was accepted")


def test_in_memory_database_uses_persistent_connection():
    storage = Storage(":memory:")
    storage.update_settings(SettingsUpdate(port="COM3"))
    assert storage.settings().port == "COM3"
