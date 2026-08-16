from __future__ import annotations

import threading
from typing import Any


class PlaybackManager:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self._lock = threading.RLock()
        self._active = False

    @property
    def active(self) -> bool:
        with self._lock:
            return self._active

    def play(self, audio, sample_rate: int) -> None:
        import sounddevice as sd

        with self._lock:
            self._active = True
        try:
            sd.play(audio, sample_rate, device=self.config.get("device"), blocking=False)
            sd.wait()
        finally:
            with self._lock:
                self._active = False

    def stop(self) -> None:
        import sounddevice as sd

        sd.stop()
        with self._lock:
            self._active = False
