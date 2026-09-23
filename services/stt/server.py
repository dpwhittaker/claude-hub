#!/usr/bin/env python3
"""Speech-to-text for claude-hub's glasses client (claude-hub SPEC §V78).

POST /transcribe   body = raw PCM 16 kHz signed 16-bit little-endian mono
                   (Content-Type audio/L16; rate=16000), or any container
                   faster-whisper can decode (wav/flac/ogg/…) → {"text", "seconds", "ms", "device"}
GET  /health       → {"ok": true, "model", "device", "loaded", "leased"}

GPU policy (~/projects/gpu-gate): the RTX 4080 is shared with ollama's
ollama. On the first request we take a gpu-gate lease (which evicts ollama),
load the model onto the GPU, and keep both while requests keep coming. After
IDLE_SECONDS without a request the model is dropped and the lease released, so
the card goes back to background work. If the gate is unreachable we fall back
to a CPU int8 model rather than fail — slower, never wrong.
"""
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

PORT = int(os.environ.get('STT_PORT', '8012'))
MODEL = os.environ.get('STT_MODEL', 'turbo')
GATE = os.environ.get('GPU_GATE_URL', 'http://127.0.0.1:11435')
LEASE_TTL = int(os.environ.get('STT_LEASE_TTL', '300'))
IDLE_SECONDS = int(os.environ.get('STT_IDLE_SECONDS', '90'))
MAX_BYTES = 16 * 1024 * 1024
OWNER = 'stt'

_lock = threading.Lock()
_model = None
_device = None
_leased = False
_last_used = 0.0


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)


def gate(path, body):
    req = urllib.request.Request(GATE + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def acquire_model():
    """Load (or reuse) the model. Prefers GPU behind a gate lease; CPU fallback."""
    global _model, _device, _leased, _last_used
    from faster_whisper import WhisperModel
    with _lock:
        _last_used = time.time()
        if _model is not None:
            return _model, _device
        try:
            gate('/lease', {'owner': OWNER, 'ttl': LEASE_TTL})
            _leased = True
            t = time.time()
            _model = WhisperModel(MODEL, device='cuda', compute_type='float16')
            _device = 'cuda'
            log(f'model {MODEL} on cuda in {time.time() - t:.1f}s')
        except Exception as e:  # gate down, CUDA missing, OOM…
            log('gpu path failed, using cpu:', e)
            if _leased:
                try: gate('/release', {'owner': OWNER})
                except Exception: pass
                _leased = False
            t = time.time()
            _model = WhisperModel(MODEL, device='cpu', compute_type='int8')
            _device = 'cpu'
            log(f'model {MODEL} on cpu in {time.time() - t:.1f}s')
        return _model, _device


def release_if_idle():
    global _model, _device, _leased
    while True:
        time.sleep(5)
        with _lock:
            if _model is not None and time.time() - _last_used > IDLE_SECONDS:
                log('idle: dropping model, releasing gpu')
                _model = None
                _device = None
                if _leased:
                    try: gate('/release', {'owner': OWNER})
                    except Exception as e: log('release failed:', e)
                    _leased = False


def pcm_to_float(data: bytes) -> np.ndarray:
    if len(data) % 2:
        data = data[:-1]
    return np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {'ok': True, 'model': MODEL, 'device': _device, 'loaded': _model is not None, 'leased': _leased})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/transcribe':
            return self._json(404, {'error': 'not found'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._json(400, {'error': 'body required (≤ 16 MB)'})
        data = self.rfile.read(n)
        ctype = (self.headers.get('Content-Type') or '').lower()
        t0 = time.time()
        try:
            model, device = acquire_model()
            if ctype.startswith('audio/l16') or ctype == 'application/octet-stream':
                audio = pcm_to_float(data)
            else:
                import io
                from faster_whisper.audio import decode_audio
                audio = decode_audio(io.BytesIO(data), sampling_rate=16000)
            seconds = float(len(audio)) / 16000.0
            segments, _info = model.transcribe(audio, language='en', beam_size=1, vad_filter=True, condition_on_previous_text=False)
            text = ' '.join(s.text.strip() for s in segments).strip()
        except Exception as e:
            log('transcribe failed:', repr(e))
            return self._json(500, {'error': f'transcribe failed: {e}'})
        ms = int((time.time() - t0) * 1000)
        log(f'{seconds:.1f}s audio → {ms} ms on {device}: {text[:80]!r}')
        self._json(200, {'text': text, 'seconds': round(seconds, 2), 'ms': ms, 'device': device})

    def log_message(self, *_):  # quiet the default access log
        pass


if __name__ == '__main__':
    threading.Thread(target=release_if_idle, daemon=True).start()
    log(f'stt listening on 127.0.0.1:{PORT} model={MODEL} gate={GATE}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
