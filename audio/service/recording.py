from __future__ import annotations

import math
import threading
import time
import uuid
import wave
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np


class Recording:
    def __init__(self, config: dict[str, Any], output_dir: str) -> None:
        self.config = config
        self.output_dir = Path(output_dir)
        self.id = uuid.uuid4().hex
        self.state = "recording"
        self.reason: str | None = None
        self.path: str | None = None
        self.duration_ms = 0
        self.error: str | None = None
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f"recording-{self.id}", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def status(self) -> dict[str, Any]:
        result: dict[str, Any] = {"id": self.id, "state": self.state}
        if self.reason:
            result["reason"] = self.reason
        if self.path:
            result["path"] = self.path
        if self.duration_ms:
            result["durationMs"] = self.duration_ms
        if self.error:
            result["error"] = self.error
        return result

    def _run(self) -> None:
        try:
            import sounddevice as sd

            sample_rate = int(self.config.get("sampleRate", 16000))
            channels = int(self.config.get("channels", 1))
            block_ms = int(self.config.get("blockMs", 30))
            block_size = max(1, round(sample_rate * block_ms / 1000))
            pre_roll_blocks = max(1, math.ceil(int(self.config.get("preRollMs", 300)) / block_ms))
            silence_blocks = max(1, math.ceil(int(self.config.get("silenceMs", 1100)) / block_ms))
            minimum_blocks = max(1, math.ceil(int(self.config.get("minimumSpeechMs", 250)) / block_ms))
            startup_blocks = max(1, math.ceil(int(self.config.get("startupTimeoutMs", 10000)) / block_ms))
            maximum_blocks = max(1, math.ceil(int(self.config.get("maximumDurationMs", 45000)) / block_ms))
            base_threshold = float(self.config.get("energyThreshold", 0.012))
            device = self.config.get("device")

            pre_roll: deque[np.ndarray] = deque(maxlen=pre_roll_blocks)
            captured: list[np.ndarray] = []
            noise_samples: list[float] = []
            speech_started = False
            quiet_blocks = 0
            total_blocks = 0
            detection_threshold = base_threshold

            with sd.InputStream(
                samplerate=sample_rate,
                channels=channels,
                dtype="float32",
                blocksize=block_size,
                device=device,
            ) as stream:
                while not self.stop_event.is_set() and total_blocks < maximum_blocks:
                    block, _overflowed = stream.read(block_size)
                    mono = np.asarray(block[:, 0], dtype=np.float32).copy()
                    total_blocks += 1
                    rms = float(np.sqrt(np.mean(np.square(mono), dtype=np.float64)))

                    if not speech_started:
                        pre_roll.append(mono)
                        if total_blocks <= min(startup_blocks, 30):
                            noise_samples.append(rms)
                        noise_floor = float(np.median(noise_samples)) if noise_samples else 0.0
                        detection_threshold = max(base_threshold, noise_floor * 3.0)
                        if rms >= detection_threshold:
                            speech_started = True
                            captured.extend(pre_roll)
                            pre_roll.clear()
                        elif total_blocks >= startup_blocks:
                            self.reason = "no speech detected"
                            break
                        continue

                    captured.append(mono)
                    if rms >= detection_threshold:
                        quiet_blocks = 0
                    else:
                        quiet_blocks += 1
                    if len(captured) >= minimum_blocks and quiet_blocks >= silence_blocks:
                        self.reason = "silence"
                        break

            if total_blocks >= maximum_blocks:
                self.reason = "maximum duration"
            elif self.stop_event.is_set() and not self.reason:
                self.reason = "manual stop"

            if captured:
                audio = np.concatenate(captured)
                self.duration_ms = round(len(audio) / sample_rate * 1000)
                self.output_dir.mkdir(parents=True, exist_ok=True)
                destination = (self.output_dir / f"{self.id}.wav").resolve()
                pcm = np.clip(audio, -1.0, 1.0)
                pcm = (pcm * 32767.0).astype("<i2")
                with wave.open(str(destination), "wb") as handle:
                    handle.setnchannels(1)
                    handle.setsampwidth(2)
                    handle.setframerate(sample_rate)
                    handle.writeframes(pcm.tobytes())
                self.path = str(destination)
            self.state = "finished" if self.path else "stopped"
        except Exception as exc:
            self.error = str(exc)
            self.reason = "recording error"
            self.state = "error"


class RecordingManager:
    def __init__(self, config: dict[str, Any], output_dir: str) -> None:
        self.config = config
        self.output_dir = output_dir
        self.lock = threading.RLock()
        self.recordings: dict[str, Recording] = {}
        self.active_id: str | None = None

    def start(self) -> dict[str, Any]:
        with self.lock:
            if self.active_id:
                active = self.recordings.get(self.active_id)
                if active and active.state == "recording":
                    raise RuntimeError("A microphone recording is already active.")
            recording = Recording(self.config, self.output_dir)
            self.recordings[recording.id] = recording
            self.active_id = recording.id
            recording.start()
            return recording.status()

    def get(self, recording_id: str) -> dict[str, Any]:
        with self.lock:
            recording = self.recordings.get(recording_id)
            if recording is None:
                raise KeyError("Recording not found.")
            status = recording.status()
            if recording.state != "recording" and self.active_id == recording_id:
                self.active_id = None
            return status

    def stop(self, recording_id: str) -> dict[str, Any]:
        with self.lock:
            recording = self.recordings.get(recording_id)
            if recording is None:
                raise KeyError("Recording not found.")
            recording.stop()
        recording.thread.join(timeout=5)
        return self.get(recording_id)

    def stop_active(self) -> None:
        with self.lock:
            recording_id = self.active_id
        if recording_id:
            try:
                self.stop(recording_id)
            except Exception:
                pass
