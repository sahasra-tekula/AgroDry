from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SensorEvent:
    temperature: float | None = None
    humidity: float | None = None
    sensor_error: bool = False


class SerialParser:
    """Parse JSON-line reports and the line-oriented output of AgroDry.ino."""

    _temperature = re.compile(r"^\s*Temperature\s*:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))", re.I)
    _humidity = re.compile(r"^\s*Relative\s+Humidity\s*:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))", re.I)

    def __init__(self) -> None:
        self._temperature_value: float | None = None
        self._humidity_value: float | None = None

    def feed_line(self, line: str) -> SensorEvent | None:
        line = line.strip()
        if not line:
            return None

        if line.startswith("{"):
            try:
                data = json.loads(line)
                return self._parse_json(data)
            except (ValueError, TypeError):
                return None

        if re.search(r"\bSTATUS\s*:\s*SENSOR\s+ERROR\b", line, re.I):
            self._temperature_value = self._humidity_value = None
            return SensorEvent(sensor_error=True)

        match = self._temperature.match(line)
        if match:
            self._temperature_value = self._finite_float(match.group(1))
        match = self._humidity.match(line)
        if match:
            self._humidity_value = self._finite_float(match.group(1))

        if self._temperature_value is not None and self._humidity_value is not None:
            temperature = self._temperature_value
            humidity = self._humidity_value
            self._temperature_value = self._humidity_value = None
            if self._valid_reading(temperature, humidity):
                return SensorEvent(temperature, humidity)
        return None

    def _parse_json(self, data: Any) -> SensorEvent | None:
        if not isinstance(data, dict):
            return None
        status = str(data.get("status", "")).strip().upper().replace(" ", "_")
        if status == "SENSOR_ERROR":
            return SensorEvent(sensor_error=True)
        if status != "OK":
            return None
        temperature = self._finite_float(data.get("temperature"))
        humidity = self._finite_float(data.get("humidity"))
        if temperature is None or humidity is None or not self._valid_reading(temperature, humidity):
            return None
        return SensorEvent(temperature, humidity)

    @staticmethod
    def _valid_reading(temperature: float, humidity: float) -> bool:
        return -40 <= temperature <= 80 and 0 <= humidity <= 100

    @staticmethod
    def _finite_float(value: Any) -> float | None:
        try:
            result = float(value)
        except (ValueError, TypeError, OverflowError):
            return None
        return result if math.isfinite(result) else None
