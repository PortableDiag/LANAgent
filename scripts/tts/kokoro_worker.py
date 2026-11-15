"""Kokoro-82M text-to-speech worker (kokoro-onnx), one JSON request per line on stdin.

Request:  {"id": 1, "text": "...", "voice": "af_nicole", "speed": 1.0, "lang": "en-us"}
Answer:   {"id": 1, "ok": true, "wav_b64": "...", "sample_rate": 24000, "seconds": 5.8}
          {"id": 1, "ok": false, "error": "..."}

Started by src/services/kokoroTts.js as an unprivileged user, with the model in KOKORO_DIR
(kokoro-v1.0.onnx + voices-v1.0.bin). It loads the model once and stays up until the parent
closes stdin or stops it for being idle. The first line it prints is {"ready": true, "voices": [...]}.
"""
import base64
import io
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_DIR = os.environ.get("KOKORO_DIR", "/var/lib/kokoro")


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        kokoro = Kokoro(os.path.join(MODEL_DIR, "kokoro-v1.0.onnx"), os.path.join(MODEL_DIR, "voices-v1.0.bin"))
    except Exception as e:  # missing model files, broken install
        say({"ready": False, "error": str(e)[:300]})
        return
    say({"ready": True, "voices": sorted(kokoro.get_voices())})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            text = str(req.get("text") or "").strip()
            if not text:
                raise ValueError("no text")
            samples, rate = kokoro.create(text[:5000], voice=req.get("voice") or "af_heart",
                                          speed=float(req.get("speed") or 1.0), lang=req.get("lang") or "en-us")
            buf = io.BytesIO()
            sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
            say({"id": rid, "ok": True, "wav_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
                 "sample_rate": rate, "seconds": round(len(samples) / rate, 2)})
        except Exception as e:
            say({"id": rid, "ok": False, "error": str(e)[:300]})


if __name__ == "__main__":
    main()
