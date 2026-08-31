"""Live test for V9 screenshot Q&A (port 8775, real provider, db COPY).

Self-contained: copies the real workbench.db (tasks disabled in the copy,
keys never printed), boots a scratch server, then verifies with the real
provider:
  1. vision path — uploaded screenshot embedded as markdown → image_url
     content block → a qwen-vl model reads the number off the image;
  2. local OCR path — /api/images/ocr reads the same screenshot.
"""
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".livetest9"
BASE = "http://127.0.0.1:8775"


def make_screenshot() -> bytes:
    img = Image.new("RGB", (900, 420), "#f5f5f7")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 900, 90], fill="#2563eb")
    d.text((30, 22), "Deploy ticket", fill="white", font=ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 44))
    d.text((40, 140), "Build 2049 finished", fill="#111111", font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 38))
    d.text((40, 220), "Owner: workbench", fill="#111111", font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 38))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def req(method: str, path: str, body: dict | None = None, form: tuple[str, bytes] | None = None, timeout: int = 300):
    if form is not None:
        filename, content = form
        boundary = "----wblive"
        data = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: image/png\r\n\r\n"
        ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    else:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def sse_chat(payload: dict) -> tuple[str, list[str]]:
    """Returns (answer_text, events_seen)."""
    r = urllib.request.Request(
        BASE + "/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    text, events, err = [], [], ""
    with urllib.request.urlopen(r, timeout=300) as resp:
        event = ""
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if line.startswith("event: "):
                event = line[7:]
                events.append(event)
            elif line.startswith("data: ") and event:
                data = json.loads(line[6:])
                if event == "delta":
                    text.append(data.get("text", ""))
                elif event in ("error", "model_error"):
                    err = data.get("message", "unknown")
    assert not err, f"chat stream error: {err}"
    return "".join(text), events


def wait_health(seconds: int = 180) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("GET", "/api/health", timeout=3)
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("backend never became healthy")


def pick_vision_model() -> str:
    for p in req("GET", "/api/settings/providers"):
        if p["enabled"] and p["models"]:
            name = p["name"]
            for m in p["models"]:
                if "vl" in m or "vision" in m:
                    return f"{name}/{m}"
            # provider name is dashscope-like → vl models share the same key
            return f"{name}/qwen-vl-plus"
    raise SystemExit("no enabled provider in the copy")


def main() -> None:
    db_src = BACKEND.parent / "data" / "workbench.db"
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    shutil.copy2(db_src, SCRATCH / "live.db")
    for suffix in ("-wal", "-shm"):
        if Path(str(db_src) + suffix).exists():
            shutil.copy2(str(db_src) + suffix, str(SCRATCH / "live.db") + suffix)
    conn = sqlite3.connect(SCRATCH / "live.db")
    conn.execute("UPDATE tasks SET enabled = 0")  # the copy must not run jobs
    conn.commit()
    conn.close()

    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "live.db"),
        "WB_CONFIG_PATH": str(BACKEND.parent / "data" / "config.json"),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8775"],
        cwd=str(BACKEND),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    shot = make_screenshot()
    try:
        wait_health()
        model = pick_vision_model()
        print(f"health ok, vision model: {model} (key never printed)")

        # ---- 1. local OCR over the uploaded screenshot ----
        saved = req("POST", "/api/images/upload", form=("ticket.png", shot))
        r = req("POST", "/api/images/ocr", {"name": saved["name"]})
        assert "2049" in r["text"], r
        print(f"ocr ok: {r['text'][:50]!r}")

        # ---- 2. vision model reads the screenshot (real image_url block) ----
        conv = req("POST", "/api/conversations", {"model_id": model})
        try:
            answer, events = sse_chat(
                {
                    "conversation_id": conv["id"],
                    "model_id": model,
                    "content": f"这是一张截图。截图里 Build 的编号是多少？只回答数字。\n\n![]({saved['url']})",
                    "use_rag": False,
                }
            )
            assert "images_attached" in events, events
            assert "2049" in answer.replace(" ", ""), answer
            print(f"vision ok: answer={answer.strip()[:60]!r}")
        finally:
            req("DELETE", f"/api/conversations/{conv['id']}")

        print("LIVE TEST PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
