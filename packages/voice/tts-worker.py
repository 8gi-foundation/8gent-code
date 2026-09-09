#!/usr/bin/env python3
"""
8gent Code - long-lived local TTS worker.

One process per engine per TUI session. Loads the model once, then serves
synthesis requests over stdio so each utterance costs a fraction of a second
instead of a fresh interpreter plus model load.

Protocol (one JSON object per line, UTF-8):

  worker -> host on startup
    {"event": "ready", "engine": "kitten", "voices": [...], "load_ms": 812}
    {"event": "error", "error": "..."}            (then exit 1)

  host -> worker
    {"id": 1, "text": "Hello.", "voice": "Jasper", "out": "/tmp/x.wav"}

  worker -> host per request
    {"id": 1, "path": "/tmp/x.wav", "ms": 118, "seconds": 2.7}
    {"id": 1, "error": "..."}

Everything the model libraries print goes to stderr; stdout carries only the
protocol. The host plays the wav (afplay) and deletes it.

Usage: tts-worker.py --engine kitten|supertonic
"""

import argparse
import json
import os
import sys
import time
import wave


def _protocol_stream():
    # Hold the real stdout as the protocol channel, then point sys.stdout at
    # stderr so library chatter (KittenTTS prints "Generating audio for ...")
    # cannot corrupt the JSON line stream.
    proto = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    sys.stdout = sys.stderr
    return proto


def _write_wav(path, samples, sample_rate):
    import numpy as np

    data = np.asarray(samples, dtype=np.float32)
    if data.ndim > 1:
        data = data.reshape(-1)
    data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return len(pcm) / float(sample_rate)


class KittenEngine:
    name = "kitten"

    def __init__(self):
        from kittentts import KittenTTS

        self.model = KittenTTS()
        self.voices = list(self.model.available_voices)
        self.sample_rate = 24000

    def synthesize(self, text, voice):
        if voice not in self.voices:
            voice = self.voices[0]
        return self.model.generate(text, voice=voice), self.sample_rate


class SupertonicEngine:
    name = "supertonic"

    def __init__(self):
        from supertonic import TTS

        self.model = TTS(model="supertonic-3")
        self.voices = list(getattr(self.model, "voice_style_names", []) or [
            "M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5",
        ])
        self.sample_rate = int(getattr(self.model, "sample_rate", 44100))
        self._styles = {}

    def _style(self, voice):
        if voice not in self.voices:
            voice = self.voices[0]
        style = self._styles.get(voice)
        if style is None:
            style = self.model.get_voice_style(voice)
            self._styles[voice] = style
        return style

    def synthesize(self, text, voice):
        wav, _durations = self.model.synthesize(text, voice_style=self._style(voice))
        return wav, self.sample_rate


ENGINES = {"kitten": KittenEngine, "supertonic": SupertonicEngine}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=sorted(ENGINES), required=True)
    args = parser.parse_args()

    proto = _protocol_stream()

    def send(obj):
        proto.write(json.dumps(obj) + "\n")
        proto.flush()

    started = time.time()
    try:
        engine = ENGINES[args.engine]()
    except Exception as exc:  # noqa: BLE001 - report anything, the host decides
        send({"event": "error", "error": "%s: %s" % (type(exc).__name__, exc)})
        return 1

    send({
        "event": "ready",
        "engine": engine.name,
        "voices": engine.voices,
        "load_ms": int((time.time() - started) * 1000),
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            send({"id": None, "error": "bad request line"})
            continue
        req_id = req.get("id")
        text = (req.get("text") or "").strip()
        voice = req.get("voice") or engine.voices[0]
        out = req.get("out") or os.path.join(
            os.environ.get("TMPDIR", "/tmp"), "8gent-tts-%s-%s.wav" % (engine.name, req_id)
        )
        if not text:
            send({"id": req_id, "error": "empty text"})
            continue
        t0 = time.time()
        try:
            samples, rate = engine.synthesize(text, voice)
            seconds = _write_wav(out, samples, rate)
        except Exception as exc:  # noqa: BLE001
            send({"id": req_id, "error": "%s: %s" % (type(exc).__name__, exc)})
            continue
        send({
            "id": req_id,
            "path": out,
            "ms": int((time.time() - t0) * 1000),
            "seconds": round(seconds, 2),
        })
    return 0


if __name__ == "__main__":
    sys.exit(main())
