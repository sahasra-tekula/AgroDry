from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Reading(BaseModel):
    timestamp: datetime
    temperature: float | None = None
    humidity: float | None = None
    status: str


class Settings(BaseModel):
    max_temperature: float = Field(default=40.0, ge=-40, le=125)
    max_humidity: float = Field(default=65.0, ge=0, le=100)
    stale_timeout_seconds: int = Field(default=10, ge=2, le=3600)
    port: str = Field(default="", max_length=128)


class SettingsUpdate(BaseModel):
    max_temperature: float | None = Field(default=None, ge=-40, le=125)
    max_humidity: float | None = Field(default=None, ge=0, le=100)
    stale_timeout_seconds: int | None = Field(default=None, ge=2, le=3600)
    port: str | None = Field(default=None, max_length=128)


class DeviceConnectRequest(BaseModel):
    port: str = Field(min_length=1, max_length=128)


class Alert(BaseModel):
    id: int
    timestamp: datetime
    severity: Literal["warning", "error", "info"]
    measurement: str
    value: float | None = None
    threshold: float | None = None
    reason: str
