from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .models import Alert, Reading, Settings, SettingsUpdate


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Storage:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._uri = False
        self._keeper: sqlite3.Connection | None = None
        if self.path == ":memory:":
            self.path = f"file:agrodry-{id(self)}?mode=memory&cache=shared"
            self._uri = True
            self._keeper = sqlite3.connect(self.path, uri=True, check_same_thread=False)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, uri=self._uri)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._lock, self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    max_temperature REAL NOT NULL DEFAULT 40,
                    max_humidity REAL NOT NULL DEFAULT 65,
                    stale_timeout_seconds INTEGER NOT NULL DEFAULT 10,
                    port TEXT NOT NULL DEFAULT ''
                );
                INSERT OR IGNORE INTO settings (id) VALUES (1);
                CREATE TABLE IF NOT EXISTS readings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    temperature REAL,
                    humidity REAL,
                    status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    measurement TEXT NOT NULL,
                    value REAL,
                    threshold REAL,
                    reason TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS active_conditions (
                    condition TEXT PRIMARY KEY,
                    active INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS device_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    connection_status TEXT NOT NULL DEFAULT 'disconnected',
                    last_seen TEXT,
                    sensor_status TEXT NOT NULL DEFAULT 'unknown'
                );
                INSERT OR IGNORE INTO device_state (id) VALUES (1);
                """
            )

    @staticmethod
    def _iso(value: datetime) -> str:
        return value.astimezone(timezone.utc).isoformat()

    def settings(self) -> Settings:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM settings WHERE id=1").fetchone()
        return Settings(**dict(row))

    def update_settings(self, update: SettingsUpdate) -> Settings:
        changes = update.model_dump(exclude_unset=True, exclude_none=True)
        with self._lock, self._connect() as db:
            if changes:
                assignments = ", ".join(f"{key}=?" for key in changes)
                db.execute(
                    f"UPDATE settings SET {assignments} WHERE id=1",
                    tuple(changes.values()),
                )
        return self.settings()

    def record_reading(self, reading: Reading) -> None:
        with self._lock, self._connect() as db:
            db.execute(
                "INSERT INTO readings(timestamp,temperature,humidity,status) VALUES(?,?,?,?)",
                (self._iso(reading.timestamp), reading.temperature, reading.humidity, reading.status),
            )
            db.execute(
                "UPDATE device_state SET last_seen=?, sensor_status=? WHERE id=1",
                (self._iso(reading.timestamp), reading.status),
            )

    def latest_reading(self) -> Reading | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM readings ORDER BY id DESC LIMIT 1").fetchone()
        return self._reading(row) if row else None

    def readings(
        self,
        limit: int = 1000,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> list[Reading]:
        filters: list[str] = []
        parameters: list[Any] = []
        if start is not None:
            filters.append("timestamp >= ?")
            parameters.append(self._iso(start))
        if end is not None:
            filters.append("timestamp <= ?")
            parameters.append(self._iso(end))
        where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
        with self._lock, self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM (SELECT * FROM readings {where_clause} "
                "ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
                (*parameters, limit),
            ).fetchall()
        return [self._reading(row) for row in rows]

    @staticmethod
    def _reading(row: sqlite3.Row) -> Reading:
        return Reading(
            timestamp=datetime.fromisoformat(row["timestamp"]),
            temperature=row["temperature"],
            humidity=row["humidity"],
            status=row["status"],
        )

    def set_connection(self, status: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE device_state SET connection_status=? WHERE id=1", (status,))

    def device_state(self) -> dict[str, Any]:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM device_state WHERE id=1").fetchone()
        return dict(row)

    def transition_alert(
        self,
        condition: str,
        active: bool,
        *,
        severity: str,
        measurement: str,
        value: float | None,
        threshold: float | None,
        reason: str,
        timestamp: datetime,
    ) -> Alert | None:
        """Store only inactive-to-active edges; clearing a condition rearms it."""
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT active FROM active_conditions WHERE condition=?", (condition,)
            ).fetchone()
            was_active = bool(row["active"]) if row else False
            db.execute(
                "INSERT INTO active_conditions(condition,active) VALUES(?,?) "
                "ON CONFLICT(condition) DO UPDATE SET active=excluded.active",
                (condition, int(active)),
            )
            if not active or was_active:
                return None
            cursor = db.execute(
                "INSERT INTO alerts(timestamp,severity,measurement,value,threshold,reason) "
                "VALUES(?,?,?,?,?,?)",
                (self._iso(timestamp), severity, measurement, value, threshold, reason),
            )
            return Alert(
                id=cursor.lastrowid,
                timestamp=timestamp,
                severity=severity,
                measurement=measurement,
                value=value,
                threshold=threshold,
                reason=reason,
            )

    def alerts(self, limit: int = 1000) -> list[Alert]:
        with self._lock, self._connect() as db:
            rows = db.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [
            Alert(
                id=row["id"],
                timestamp=datetime.fromisoformat(row["timestamp"]),
                severity=row["severity"],
                measurement=row["measurement"],
                value=row["value"],
                threshold=row["threshold"],
                reason=row["reason"],
            )
            for row in rows
        ]

    def export_rows(self, table: str) -> list[dict[str, Any]]:
        if table not in {"readings", "alerts"}:
            raise ValueError("Unsupported export")
        with self._lock, self._connect() as db:
            rows = db.execute(f"SELECT * FROM {table} ORDER BY id ASC").fetchall()
        return [dict(row) for row in rows]

    def count_readings(self) -> int:
        with self._lock, self._connect() as db:
            return db.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
