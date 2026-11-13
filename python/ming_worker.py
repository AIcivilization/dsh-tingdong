"""Ming voice worker, from dsh-her (lib/tts-worker.js starts it with the Ming Python).

One JSON request per line on stdin, one JSON reply per line on stdout; the
model is loaded once and stays loaded. Everything the libraries print goes
to stderr, so stdout carries only replies.

  {"op": "load", "id": n, "model": dir}    -> {"id": n, "ok": true, "loadMs": n}
  {"op": "speak", "id": n, "text": ...,    -> {"id": n, "ok": true, "pcm16": base64,
   "voice": built-in name                      "sampleRate": 44100, "ms": n}
   | "ref": {"wav": path, "text": ...}       (or {"id": n, "ok": false, "error": ...})
   | "design": a description of the voice,
   "emotion": "高兴"?, "speed": "慢速"?, "steps": 10, "seed": n?}
"""

import base64
import json
import sys
import time

replies = sys.stdout
sys.stdout = sys.stderr

import mlx.core as mx  # noqa: E402
import numpy as np  # noqa: E402
from mlx_audio.tts.models.bailingmm.bailingmm import ming3_instruction  # noqa: E402
from mlx_audio.tts.utils import load_model  # noqa: E402

model = None


def reply(message):
    replies.write(json.dumps(message, ensure_ascii=False) + "\n")
    replies.flush()


def speak(request):
    args = {"text": request["text"], "ddpm_steps": int(request.get("steps", 10))}
    emotion = request.get("emotion")
    speed = request.get("speed")
    if request.get("seed") is not None:
        mx.random.seed(int(request["seed"]))
    if request.get("design"):
        # A voice from its description: no speaker, the description is the whole instruction.
        args.update(instruct=request["design"], use_zero_spk_emb=True)
    elif request.get("ref"):
        args.update(ref_audio=request["ref"]["wav"], ref_text=request["ref"]["text"])
        if emotion or speed:
            args["instruct"] = ming3_instruction(emotion=emotion, speed=speed)
    elif request.get("voice"):
        if emotion or speed:
            args.update(instruct=ming3_instruction(emotion=emotion, speed=speed, ip=request["voice"]), use_zero_spk_emb=True)
        else:
            args["voice"] = request["voice"]
    audio = np.concatenate([np.array(part.audio) for part in model.generate(**args)])
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    return base64.b64encode(pcm.tobytes()).decode("ascii")


for line in sys.stdin:
    if not line.strip():
        continue
    request = {}
    try:
        request = json.loads(line)
        started = time.perf_counter()
        if request["op"] == "load":
            model = load_model(request["model"])
            # The first sentence after loading is slow (about 5 s); pay for it now.
            speak({"text": "嗯。", "voice": "灵小柔", "steps": 5})
            reply({"id": request.get("id"), "ok": True, "loadMs": round((time.perf_counter() - started) * 1000)})
        elif request["op"] == "speak":
            pcm16 = speak(request)
            reply({"id": request["id"], "ok": True, "pcm16": pcm16, "sampleRate": model.sample_rate, "ms": round((time.perf_counter() - started) * 1000)})
        else:
            raise ValueError("unknown op " + str(request.get("op")))
    except Exception as error:  # noqa: BLE001 - every failure goes back to the plugin
        reply({"id": request.get("id"), "ok": False, "error": f"{type(error).__name__}: {error}"})
