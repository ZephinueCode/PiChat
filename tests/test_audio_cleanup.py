from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from audio.service.server import AudioApplication, Handler


class _IdleRecordings:
    def stop_active(self) -> None:
        pass


class _IdlePlayback:
    def stop(self) -> None:
        pass


class AudioCleanupTests(unittest.TestCase):
    def make_app(self, root: Path, recordings: Path, generated: Path) -> AudioApplication:
        app = AudioApplication.__new__(AudioApplication)
        app.config = {
            "_configRoot": str(root),
            "storage": {
                "recordings": str(recordings),
                "generated": str(generated),
            },
        }
        app.recordings = _IdleRecordings()
        app.playback = _IdlePlayback()
        app.work_lock = threading.RLock()
        return app

    def test_cleanup_deletes_only_direct_transient_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recordings = root / "recordings"
            generated = root / "generated"
            recordings.mkdir()
            generated.mkdir()
            (recordings / "mic.wav").write_bytes(b"audio")
            (recordings / "unfinished.tmp").write_bytes(b"audio")
            (recordings / "keep.txt").write_text("keep", encoding="utf-8")
            nested = recordings / "nested"
            nested.mkdir()
            (nested / "keep.wav").write_bytes(b"audio")
            (generated / "speech.FLAC").write_bytes(b"audio")
            outside = root / "outside.wav"
            outside.write_bytes(b"audio")

            app = self.make_app(root, recordings, generated)
            result = app.cleanup_transient_audio()

            self.assertEqual(result, {"recordings": 2, "generated": 1, "total": 3})
            self.assertTrue((recordings / "keep.txt").exists())
            self.assertTrue((nested / "keep.wav").exists())
            self.assertTrue(outside.exists())
            self.assertEqual(
                app.cleanup_transient_audio(),
                {"recordings": 0, "generated": 0, "total": 0},
            )

    def test_cleanup_refuses_config_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generated = root / "generated"
            generated.mkdir()
            app = self.make_app(root, root, generated)

            with self.assertRaisesRegex(RuntimeError, "unsafe recordings directory"):
                app.cleanup_transient_audio()

    def test_cleanup_refuses_persistent_storage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recordings = root / "voices" / "private"
            generated = root / "generated"
            recordings.mkdir(parents=True)
            generated.mkdir()
            app = self.make_app(root, recordings, generated)

            with self.assertRaisesRegex(RuntimeError, "protected recordings directory"):
                app.cleanup_transient_audio()

    def test_cleanup_endpoint_waits_for_deletion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recordings = root / "recordings"
            generated = root / "generated"
            recordings.mkdir()
            generated.mkdir()
            (generated / "speech.wav").write_bytes(b"audio")
            app = self.make_app(root, recordings, generated)
            Handler.app = app
            Handler.token = ""
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                request = Request(
                    f"http://127.0.0.1:{server.server_port}/v1/storage/cleanup",
                    data=b"{}",
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                with urlopen(request, timeout=5) as response:
                    result = json.loads(response.read().decode("utf-8"))

                self.assertEqual(result, {"recordings": 0, "generated": 1, "total": 1})
                self.assertFalse((generated / "speech.wav").exists())
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
