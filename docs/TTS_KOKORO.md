# Kokoro voices (local text-to-speech)

The `kokoro` TTS provider speaks with Kokoro-82M on the agent's own machine: free, nothing leaves the host,
about 1.5 s of CPU for 6 s of speech. Bots & Borgs voice packs name a Kokoro voice per avatar (`voice.json`),
and buying one saves it as a voice preset ("Racer Blue voice"). The current voice never changes by itself:
say "switch to the Racer Blue voice" to use it.

## Setup on a host

The worker runs as its own unprivileged user, because it does not need the agent's files or keys.

```bash
sudo useradd --system --home-dir /var/lib/kokoro --create-home --shell /usr/sbin/nologin kokoro
sudo python3 -m venv /opt/kokoro
sudo /opt/kokoro/bin/pip install kokoro-onnx soundfile
cd /var/lib/kokoro
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  sudo curl -sSfL -o $f https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f
done
sudo chown kokoro:kokoro /var/lib/kokoro/*
```

`kokoro-onnx` is used rather than `kokoro` (KPipeline) because `kokoro` does not install on Python 3.13. It runs
the same weights and voice names; voice.json's `lang_code` (`a`, `b`, …) is mapped to its language (`en-us`, `en-gb`, …).

Optional `.env`: `KOKORO_PYTHON` (default `/opt/kokoro/bin/python`), `KOKORO_DIR` (default `/var/lib/kokoro`),
`KOKORO_USER` (default `kokoro`), `KOKORO_THREADS` (default 4). With no model files the provider reports itself
unavailable and the other providers are used.

The worker (`scripts/tts/kokoro_worker.py`) starts on first use, loads the model once, and stops after 10 idle minutes.
