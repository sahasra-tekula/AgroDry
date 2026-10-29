from __future__ import annotations

from datetime import datetime, timedelta

from .models import Alert, Reading
from .parser import SensorEvent
from .storage import Storage, utc_now


class StatusEvaluator:
    def __init__(self, storage: Storage):
        self.storage = storage
        self.connected_at: datetime | None = None
        self._previous_connection: str | None = None

    def process(self, event: SensorEvent) -> list[Alert]:
        now = utc_now()
        settings = self.storage.settings()
        alerts: list[Alert] = []
        if event.sensor_error:
            reading = Reading(timestamp=now, status="sensor_error")
            self.storage.record_reading(reading)
            alert = self.storage.transition_alert(
                "sensor_error", True, severity="error", measurement="sensor",
                value=None, threshold=None, reason="Sensor reported an error.", timestamp=now,
            )
            if alert:
                alerts.append(alert)
            self.storage.transition_alert(
                "temperature_high", False, severity="warning", measurement="temperature",
                value=None, threshold=settings.max_temperature, reason="", timestamp=now,
            )
            self.storage.transition_alert(
                "humidity_high", False, severity="warning", measurement="humidity",
                value=None, threshold=settings.max_humidity, reason="", timestamp=now,
            )
            return alerts

        temperature = event.temperature
        humidity = event.humidity
        if temperature is None or humidity is None:
            return alerts
        too_hot = temperature > settings.max_temperature
        too_humid = humidity > settings.max_humidity
        reading = Reading(
            timestamp=now, temperature=temperature, humidity=humidity,
            status="warning" if too_hot or too_humid else "normal",
        )
        self.storage.record_reading(reading)
        self.storage.transition_alert(
            "sensor_error", False, severity="error", measurement="sensor",
            value=None, threshold=None, reason="", timestamp=now,
        )
        for condition, active, measurement, value, threshold, reason in (
            ("temperature_high", too_hot, "temperature", temperature,
             settings.max_temperature, "Temperature exceeded the configured maximum."),
            ("humidity_high", too_humid, "humidity", humidity,
             settings.max_humidity, "Humidity exceeded the configured maximum."),
        ):
            alert = self.storage.transition_alert(
                condition, active, severity="warning", measurement=measurement,
                value=value, threshold=threshold, reason=reason if active else "", timestamp=now,
            )
            if alert:
                alerts.append(alert)
        return alerts

    def connection_status(self, is_open: bool, connected_at: datetime | None = None) -> str:
        now = utc_now()
        settings = self.storage.settings()
        state = self.storage.device_state()
        if not is_open:
            status = "disconnected"
        else:
            self.connected_at = connected_at or self.connected_at or now
            last_seen = datetime.fromisoformat(state["last_seen"]) if state["last_seen"] else None
            reference = last_seen or self.connected_at
            status = (
                "stale"
                if now - reference > timedelta(seconds=settings.stale_timeout_seconds)
                else "connected"
            )
        self.storage.set_connection(status)
        if self._previous_connection is None:
            self._previous_connection = status
        elif status != self._previous_connection:
            if status in {"stale", "disconnected"}:
                self.storage.transition_alert(
                    "device_unavailable", True, severity="error", measurement="connection",
                    value=None, threshold=None, reason=f"Device connection is {status}.", timestamp=now,
                )
            else:
                self.storage.transition_alert(
                    "device_unavailable", False, severity="error", measurement="connection",
                    value=None, threshold=None, reason="", timestamp=now,
                )
            self._previous_connection = status
        return status

    def latest_for_api(self, status: str) -> Reading | None:
        reading = self.storage.latest_reading()
        if reading and status in {"stale", "disconnected"}:
            return reading.model_copy(update={"status": status})
        return reading
