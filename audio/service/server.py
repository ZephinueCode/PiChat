from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import traceback
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import soundfile as sf

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from service.config import load_config, refresh_voice_profiles
    from service.playback import PlaybackManager
    from service.providers.funasr import FunASRProvider
    from service.providers.qwen_tts import QwenTTSProvider
    from service.recording import RecordingManager
else:
    from .config import load_config, refresh_voice_profiles
    from .playback import PlaybackManager
    from .providers.funasr import FunASRProvider
    from .providers.qwen_tts import QwenTTSProvider
    from .recording import RecordingManager


TRANSIENT_AUDIO_SUFFIXES = frozenset({
    ".wav",
    ".flac",
    ".mp3",
    ".ogg",
    ".m4a",
    ".aac",
    ".opus",
    ".tmp",
})


class AudioApplication:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.tts = QwenTTSProvider(config["tts"])
        self.asr = FunASRProvider(config["asr"])
        self.recordings = RecordingManager(config["recording"], config["storage"]["recordings"])
        self.playback = PlaybackManager(config["playback"])
        self.work_lock = threading.RLock()
        self.server: ThreadingHTTPServer | None = None

    def status(self) -> dict[str, Any]:
        recording = None
        if self.recordings.active_id:
            try:
                recording = self.recordings.get(self.recordings.active_id)
            except KeyError:
                recording = None
        return {
            "ready": True,
            "ttsLoaded": self.tts.loaded,
            "asrLoaded": self.asr.loaded,
            "playbackActive": self.playback.active,
            "recording": recording,
        }

    def voices(self) -> dict[str, Any]:
        voices = refresh_voice_profiles(self.config)
        return {
            "defaultVoice": self.config["tts"].get("defaultProfile", "default"),
            "voices": voices,
        }

    def load_tts(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        refresh_voice_profiles(self.config)
        with self.work_lock:
            self.tts.load_profile((payload or {}).get("profile"))
        return self.status()

    def unload_tts(self) -> dict[str, Any]:
        self.playback.stop()
        with self.work_lock:
            self.tts.unload()
        return self.status()

    def speech(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = str(payload.get("text", "")).strip()
        if not text:
            raise ValueError("text is required")
        if len(text) > 12000:
            raise ValueError("text is too long (maximum 12,000 characters)")
        if payload.get("interrupt", True):
            self.playback.stop()
        refresh_voice_profiles(self.config)
        with self.work_lock:
            audio, sample_rate, profile = self.tts.synthesize(
                text=text,
                profile_name=payload.get("profile"),
                language=payload.get("language"),
            )
            request_id = uuid.uuid4().hex
            output = Path(self.config["storage"]["generated"]) / f"{request_id}.wav"
            sf.write(str(output), audio, sample_rate)
        played = bool(payload.get("play", True))
        if played:
            self.playback.play(audio, sample_rate)
        return {
            "requestId": request_id,
            "durationMs": round(len(audio) / sample_rate * 1000),
            "played": played,
            "profile": profile,
            "outputPath": str(output.resolve()),
        }

    def play_generated(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = str(payload.get("requestId", "")).strip()
        if not re.fullmatch(r"[a-f0-9]{32}", request_id):
            raise ValueError("requestId must identify generated PiChat audio")
        source = Path(self.config["storage"]["generated"]) / f"{request_id}.wav"
        if not source.is_file():
            raise FileNotFoundError(f"Generated audio not found: {request_id}")
        if payload.get("interrupt", True):
            self.playback.stop()
        audio, sample_rate = sf.read(str(source), dtype="float32", always_2d=False)
        self.playback.play(audio, sample_rate)
        return {
            "requestId": request_id,
            "durationMs": round(len(audio) / sample_rate * 1000),
            "played": True,
        }

    def transcribe(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_value = str(payload.get("source", "")).strip()
        if not source_value:
            raise ValueError("source is required")
        source = Path(os.path.expandvars(os.path.expanduser(source_value))).resolve()
        if not source.is_file():
            raise FileNotFoundError(f"Audio file not found: {source}")
        with self.work_lock:
            return self.asr.transcribe(
                str(source),
                language=payload.get("language"),
                timestamps=bool(payload.get("timestamps", False)),
            )

    def _cleanup_storage_directory(self, storage_key: str) -> int:
        target = Path(self.config["storage"][storage_key]).resolve()
        config_root = Path(self.config["_configRoot"]).resolve()
        blocked_targets = {
            Path(target.anchor).resolve(),
            Path.home().resolve(),
            config_root,
        }
        if target in blocked_targets:
            raise RuntimeError(f"Refusing to clean unsafe {storage_key} directory: {target}")
        protected_roots = {
            (config_root / name).resolve()
            for name in (".venv", "cache", "datasets", "evaluations", "models", "training", "voices")
        }
        protected_roots.update(
            Path(value).resolve()
            for key, value in self.config["storage"].items()
            if key in {"cache", "models", "voices"}
        )
        if any(target == root or root in target.parents for root in protected_roots):
            raise RuntimeError(f"Refusing to clean protected {storage_key} directory: {target}")
        if not target.exists():
            return 0
        if not target.is_dir():
            raise RuntimeError(f"Configured {storage_key} path is not a directory: {target}")

        deleted = 0
        for item in target.iterdir():
            if item.suffix.lower() not in TRANSIENT_AUDIO_SUFFIXES:
                continue
            if not (item.is_file() or item.is_symlink()):
                continue
            try:
                item.unlink()
                deleted += 1
            except FileNotFoundError:
                pass
        return deleted

    def cleanup_transient_audio(self) -> dict[str, int]:
        self.recordings.stop_active()
        try:
            self.playback.stop()
        except Exception:
            pass
        with self.work_lock:
            recordings = self._cleanup_storage_directory("recordings")
            generated = self._cleanup_storage_directory("generated")
        return {
            "recordings": recordings,
            "generated": generated,
            "total": recordings + generated,
        }

    def shutdown(self) -> None:
        try:
            self.cleanup_transient_audio()
        except Exception:
            traceback.print_exc()
        with self.work_lock:
            self.tts.unload()
            self.asr.unload()
        if self.server:
            self.server.shutdown()


class Handler(BaseHTTPRequestHandler):
    app: AudioApplication
    token: str
    server_version = "PiChatAudio/0.3.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[audio] {self.address_string()} {fmt % args}\n")

    def _authorized(self) -> bool:
        if not self.token:
            return True
        return self.headers.get("Authorization") == f"Bearer {self.token}"

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _payload(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("Request body is too large")
        if length == 0:
            return {}
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON request body must be an object")
        return value

    def _run(self, action) -> None:
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
            return
        try:
            self._json(HTTPStatus.OK, action())
        except KeyError as exc:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(exc.args[0])})
        except (ValueError, FileNotFoundError, RuntimeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._run(lambda: {"ready": True})
            return
        if self.path == "/v1/status":
            self._run(self.app.status)
            return
        if self.path == "/v1/voices":
            self._run(self.app.voices)
            return
        match = re.fullmatch(r"/v1/recordings/([a-f0-9]+)", self.path)
        if match:
            self._run(lambda: self.app.recordings.get(match.group(1)))
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
            return
        if self.path == "/v1/tts/load":
            self._run(lambda: self.app.load_tts(self._payload()))
        elif self.path == "/v1/tts/unload":
            self._run(self.app.unload_tts)
        elif self.path == "/v1/audio/speech":
            self._run(lambda: self.app.speech(self._payload()))
        elif self.path == "/v1/audio/transcriptions":
            self._run(lambda: self.app.transcribe(self._payload()))
        elif self.path == "/v1/recordings/start":
            self._run(self.app.recordings.start)
        elif self.path == "/v1/playback/stop":
            self._run(lambda: (self.app.playback.stop() or {"stopped": True}))
        elif self.path == "/v1/playback/generated":
            self._run(lambda: self.app.play_generated(self._payload()))
        elif self.path == "/v1/storage/cleanup":
            self._run(self.app.cleanup_transient_audio)
        elif self.path == "/shutdown":
            self._json(HTTPStatus.OK, {"shuttingDown": True})
            threading.Thread(target=self.app.shutdown, name="shutdown", daemon=True).start()
        else:
            match = re.fullmatch(r"/v1/recordings/([a-f0-9]+)/stop", self.path)
            if match:
                self._run(lambda: self.app.recordings.stop(match.group(1)))
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})


def main() -> None:
    parser = argparse.ArgumentParser(description="PiChat local Qwen3-TTS and FunASR service")
    parser.add_argument("--config", required=True)
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    config = load_config(args.config)
    configured = config.get("service", {})
    host = args.host or configured.get("host", "127.0.0.1")
    port = args.port or int(configured.get("port", 17863))
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("PiChat audio service may bind only to localhost.")

    app = AudioApplication(config)
    Handler.app = app
    Handler.token = os.environ.get("PICHAT_AUDIO_TOKEN", "")
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    app.server = server
    print(json.dumps({"ready": True, "host": host, "port": port}), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
