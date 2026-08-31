"""One-off smoke test for V9 screenshot Q&A OCR (scratch db, port 8774).

Uploads a PIL-generated text image through the real multipart endpoint, then
runs local OCR over it via /api/images/ocr, plus the error guards.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke21"
BASE = "http://127.0.0.1:8774"


def make_png() -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1000, 300), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 110)
    d.text((50, 90), "SMOKE-2049", fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def req(method: str, path: str, body: dict | None = None, form: tuple[str, bytes] | None = None):
    if form is not None:
        filename, content = form
        boundary = "----wbsmoke"
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
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read())


def wait_health(seconds: int = 120) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("GET", "/api/health")
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("backend never became healthy")


def main() -> None:
    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "smoke.db"),
        "WB_CONFIG_PATH": str(SCRATCH / "config.json"),
    }
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8774"],
        cwd=str(BACKEND),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        saved = req("POST", "/api/images/upload", form=("shot.png", make_png()))
        assert saved["name"].startswith("img-"), saved
        print(f"upload ok ({saved['bytes']} bytes)")

        r = req("POST", "/api/images/ocr", {"name": saved["name"]})
        assert "2049" in r["text"], r
        print(f"ocr ok: {r['text'][:40]!r}")

        try:
            req("POST", "/api/images/ocr", {"name": "../evil.png"})
            raise SystemExit("bad name should be rejected")
        except urllib.error.HTTPError as e:
            assert e.code == 400, e.code

        try:
            req("POST", "/api/images/ocr", {"name": "img-20990101-000000-abc123.png"})
            raise SystemExit("missing image should 404")
        except urllib.error.HTTPError as e:
            assert e.code == 404, e.code
        print("ocr guards ok (bad name 400, missing 404)")

        print("SMOKE PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
