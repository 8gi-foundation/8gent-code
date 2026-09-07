#!/usr/bin/env python3
"""
Test double for packages/voice/tts-worker.py.

Speaks the same JSON-lines protocol without loading any model, so the
PythonWorkerTTSProvider queue, interrupt and crash paths can be unit tested
on any machine with python3. Behaviour is steered by environment variables:

  FAKE_TTS_FAIL_BOOT=1      emit an error event instead of ready and exit 1
  FAKE_TTS_DIE_AFTER=<n>    exit abruptly after answering n requests
  FAKE_TTS_LOG=<path>       append one line per request: "<id> <voice> <text>"
"""

import json
import os
import sys
import wave


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def write_silence(path, seconds=0.05, rate=8000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))


def main():
    engine = "kitten"
    if "--engine" in sys.argv:
        engine = sys.argv[sys.argv.index("--engine") + 1]
    if os.environ.get("FAKE_TTS_FAIL_BOOT"):
        send({"event": "error", "error": "fake boot failure"})
        return 1
    send({"event": "ready", "engine": engine, "voices": ["Alpha", "Beta"], "load_ms": 1})
    die_after = int(os.environ.get("FAKE_TTS_DIE_AFTER", "0") or 0)
    answered = 0
    log = os.environ.get("FAKE_TTS_LOG")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        out = req["out"]
        write_silence(out)
        if log:
            with open(log, "a") as f:
                f.write("%s %s %s\n" % (req["id"], req.get("voice"), req.get("text")))
        send({"id": req["id"], "path": out, "ms": 1, "seconds": 0.05, "voice": req.get("voice")})
        answered += 1
        if die_after and answered >= die_after:
            os._exit(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
