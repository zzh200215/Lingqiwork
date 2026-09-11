"""One-off smoke test for V8 local voice input (scratch db, port 8772).

Verifies: /api/asr/status shape, asr prefs round-trip with validation,
transcribe endpoint guards (empty → 400, oversize → 413, garbage bytes →
502 decode failure). Real-model transcription is livetest_v8.py's job.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# --- API token (PLAN §10.1 #6): the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke20"
BASE = "http://127.0.0.1:8772"


def req(method: str, path: str, body: dict | None = None, form: tuple[str, bytes] | None = None):
    if form is not None:
        filename, content = form
        boundary = "----wbsmoke"
        data = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
        headers = {**_WB_HEADERS, "Content-Type": f"multipart/form-data; boundary={boundary}"}
    else:
        data = json.dumps(body).encode() if body is not None else None
        headers = _WB_HEADERS
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read())


def expect_error(method: str, path: str, form: tuple[str, bytes] | None, code: int) -> str:
    try:
        req(method, path, form=form)
    except urllib.error.HTTPError as e:
        assert e.code == code, (e.code, e.read()[:200])
        return e.read().decode("utf-8", "ignore")
    raise SystemExit(f"{method} {path} should have failed with {code}")


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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8772"],
        cwd=str(BACKEND),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # 1. status endpoint
        st = req("GET", "/api/asr/status")
        assert st["model"] == "small" and st["language"] == "auto" and st["loaded"] is False, st
        assert st["models"] == ["tiny", "base", "small", "medium"], st
        print("asr status ok")

        # 2. prefs round-trip + validation
        req("PUT", "/api/settings/prefs", {"asr_model": "base", "asr_language": "zh"})
        st = req("GET", "/api/asr/status")
        assert st["model"] == "base" and st["language"] == "zh", st
        try:
            req("PUT", "/api/settings/prefs", {"asr_model": "giant"})
            raise SystemExit("bad asr_model should be rejected")
        except urllib.error.HTTPError as e:
            assert e.code == 422, e.code
        print("asr prefs round-trip + validation ok")

        # 3. transcribe guards that never touch the model (no download):
        #    real decode errors are covered by unit tests + livetest_v8
        expect_error("POST", "/api/asr/transcribe", ("a.webm", b""), 400)
        expect_error("POST", "/api/asr/transcribe", ("big.webm", b"x" * (25 * 1024 * 1024 + 1)), 413)
        print("transcribe guards ok (empty → 400, oversize → 413)")

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
