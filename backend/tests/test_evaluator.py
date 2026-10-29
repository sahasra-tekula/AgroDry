from datetime import datetime, timedelta, timezone

from app.evaluator import StatusEvaluator
from app.models import Reading
from app.parser import SensorEvent
from app.storage import Storage


def test_threshold_transitions_create_deduplicated_alerts_and_rearm(tmp_path):
    storage = Storage(tmp_path / "test.sqlite3")
    evaluator = StatusEvaluator(storage)

    alerts = evaluator.process(SensorEvent(41, 54))
    assert len(alerts) == 1
    assert alerts[0].measurement == "temperature"
    assert alerts[0].threshold == 40
    assert storage.latest_reading().status == "warning"

    assert evaluator.process(SensorEvent(42, 55)) == []
    assert evaluator.process(SensorEvent(39, 55)) == []
    alerts = evaluator.process(SensorEvent(41, 54))
    assert len(alerts) == 1
    assert len(storage.alerts()) == 2


def test_humidity_threshold_uses_backend_default_65(tmp_path):
    storage = Storage(tmp_path / "test.sqlite3")
    alerts = StatusEvaluator(storage).process(SensorEvent(25, 66))
    assert len(alerts) == 1
    assert alerts[0].measurement == "humidity"
    assert alerts[0].threshold == 65


def test_sensor_error_is_a_transition_with_no_fabricated_values(tmp_path):
    storage = Storage(tmp_path / "test.sqlite3")
    evaluator = StatusEvaluator(storage)
    assert len(evaluator.process(SensorEvent(sensor_error=True))) == 1
    assert evaluator.process(SensorEvent(sensor_error=True)) == []
    reading = storage.latest_reading()
    assert reading.status == "sensor_error"
    assert reading.temperature is None and reading.humidity is None
    evaluator.process(SensorEvent(22, 45))
    assert len(evaluator.process(SensorEvent(sensor_error=True))) == 1


def test_connection_stale_and_recovery_states(tmp_path):
    storage = Storage(tmp_path / "test.sqlite3")
    evaluator = StatusEvaluator(storage)
    assert evaluator.connection_status(False) == "disconnected"
    assert evaluator.connection_status(True) == "connected"
    assert evaluator.connection_status(True) == "connected"
    assert evaluator.connection_status(False) == "disconnected"
    assert [a.measurement for a in storage.alerts()] == ["connection"]


def test_old_readings_are_marked_stale_without_fabricating_data(tmp_path):
    storage = Storage(tmp_path / "test.sqlite3")
    old_time = datetime.now(timezone.utc) - timedelta(seconds=20)
    storage.record_reading(Reading(
        timestamp=old_time, temperature=24, humidity=50, status="normal"
    ))
    evaluator = StatusEvaluator(storage)
    assert evaluator.connection_status(True, connected_at=old_time) == "stale"
    reading = evaluator.latest_for_api("stale")
    assert reading.status == "stale"
    assert reading.temperature == 24
