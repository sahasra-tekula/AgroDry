from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .evaluator import StatusEvaluator
from .models import SettingsUpdate
from .parser import SerialParser
from .storage import Storage

logger = logging.getLogger(__name__)


class SerialReader(threading.Thread):
    """Owns the sole serial connection and reconnects when port settings change."""

    def __init__(
        self,
        storage: Storage,
        evaluator: StatusEvaluator,
        on_update: Callable[[], None],
        baud_rate: int = 115200,
    ):
        super().__init__(name="agrodry-serial-reader", daemon=True)
        self.storage = storage
        self.evaluator = evaluator
        self.on_update = on_update
        self.baud_rate = baud_rate
        self._stop_event = threading.Event()
        self._serial = None
        self._active_port: str | None = None
        self._settings_changed = threading.Event()
        self._attempt_complete = threading.Event()
        self._attempt_lock = threading.Lock()
        self._last_attempt_port: str | None = None
        self._last_error: str | None = None

    def stop(self) -> None:
        self._stop_event.set()
        self._settings_changed.set()
        self.join(timeout=2)

    def configure_port(self, port: str, timeout: float = 6.0) -> tuple[bool, str | None]:
        """Ask the reader thread to switch ports and wait for its open/close result."""
        with self._attempt_lock:
            if not self.is_alive() or self._stop_event.is_set():
                return False, "The serial reader is not running."
            if port and self._active_port == port and self._serial is not None:
                return True, None
            self._attempt_complete.clear()
            self.storage.update_settings(SettingsUpdate(port=port))
            self._settings_changed.set()
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._attempt_complete.wait(remaining):
                    return False, "Timed out waiting for the serial reader to apply the port change."
                self._attempt_complete.clear()
                if self._last_attempt_port == port:
                    return self._last_error is None, self._last_error

    def run(self) -> None:
        try:
            self._run_loop()
        finally:
            self._close_serial()

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            settings = self.storage.settings()
            port = settings.port.strip()
            if not port:
                self._close_serial()
                self._update_connection(False)
                self._mark_attempt(port, None)
                self._settings_changed.wait(1)
                self._settings_changed.clear()
                continue
            if self._serial is None or port != self._active_port:
                self._close_serial()
                try:
                    import serial

                    self._serial = serial.Serial(port, self.baud_rate, timeout=0.5)
                    self._active_port = port
                    self.evaluator.connected_at = None
                    self._update_connection(True)
                    self._mark_attempt(port, None)
                    parser = SerialParser()
                except Exception:
                    logger.info("Unable to open configured serial port %r", port, exc_info=True)
                    self._serial = None
                    self._active_port = None
                    self._update_connection(False)
                    self._mark_attempt(
                        port, f"Unable to open serial port {port!r}; check that it is connected and not in use."
                    )
                    self._settings_changed.wait(2)
                    self._settings_changed.clear()
                    continue
            try:
                raw = self._serial.readline()
                if raw:
                    line = raw.decode("utf-8", errors="replace")
                    event = parser.feed_line(line)
                    if event is not None:
                        self.evaluator.process(event)
                        self.on_update()
                self._update_connection(True)
            except Exception:
                logger.info("Serial connection to %r was lost", port, exc_info=True)
                self._close_serial()
                self._update_connection(False)
                self._settings_changed.wait(1)
                self._settings_changed.clear()

    def _mark_attempt(self, port: str, error: str | None) -> None:
        self._last_attempt_port = port
        self._last_error = error
        self._attempt_complete.set()

    def _close_serial(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:
                logger.debug("Error closing serial connection", exc_info=True)
        self._serial = None
        self._active_port = None

    def _update_connection(self, is_open: bool) -> None:
        before = self.storage.device_state()["connection_status"]
        status = self.evaluator.connection_status(is_open)
        if status != before:
            self.on_update()
