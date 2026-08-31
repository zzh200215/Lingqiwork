"""V13 artifacts tests: real subprocess execution against the local python
(and node when present). Only the config read is faked — the runner itself
runs for real, offline.
"""
import atexit
import shutil
import tempfile
from pathlib import Path

import pytest

from app.core import artifacts

_SCRATCHES: list[Path] = []


def _scratch() -> Path:
    d = Path(tempfile.mkdtemp(prefix="wb-art-", dir=Path(__file__).parent))
    _SCRATCHES.append(d)
    return d


def _cleanup() -> None:
    for d in _SCRATCHES:
        shutil.rmtree(d, ignore_errors=True)


atexit.register(_cleanup)


@pytest.fixture()
def art_env(monkeypatch):
    root = _scratch()
    monkeypatch.setattr(artifacts, "ARTIFACTS_DIR", root / "artifacts")
    monkeypatch.setattr(
        artifacts,
        "load_config",
        lambda: {"artifacts_enabled": True, "artifacts_timeout": 30},
    )
    return root


def test_run_python_success(art_env):
    r = artifacts.run("print('hello artifact')")
    assert r["ok"] and r["exit_code"] == 0
    assert "hello artifact" in r["stdout"]
    assert r["timeout"] is False


def test_run_python_failure(art_env):
    r = artifacts.run("1/0")
    assert not r["ok"] and r["exit_code"] == 1
    assert "ZeroDivisionError" in r["stderr"]
    # failed runs keep their throwaway dir for inspection
    assert Path(r["run_dir"]).exists()


def test_run_timeout_kills(art_env):
    # flush matters: a killed child loses anything still in its stdout buffer
    r = artifacts.run("import time; print('started', flush=True); time.sleep(10)", timeout=1)
    assert r["timeout"] is True and not r["ok"]
    assert "被终止" in r["stderr"]
    assert "started" in r["stdout"]  # partial output captured
    assert r["elapsed_ms"] < 9000


def test_output_truncated(art_env):
    r = artifacts.run("print('x' * 500_000)")
    assert len(r["stdout"].encode("utf-8")) < artifacts.MAX_OUTPUT_BYTES
    assert "截断" in r["stdout"]


def test_cwd_isolated_and_cleaned(art_env):
    r = artifacts.run(
        "from pathlib import Path; Path('side_effect.txt').write_text('v', encoding='utf-8'); print(Path.cwd().name)"
    )
    assert r["ok"]
    assert "run-" in r["stdout"]  # ran inside a fresh run-* dir
    assert not list(art_env.joinpath("artifacts").glob("run-*"))  # cleaned up


def test_disabled_raises_permission(art_env, monkeypatch):
    monkeypatch.setattr(
        artifacts,
        "load_config",
        lambda: {"artifacts_enabled": False, "artifacts_timeout": 30},
    )
    with pytest.raises(PermissionError):
        artifacts.run("print(1)")


@pytest.mark.parametrize("code,lang", [("", "python"), ("x" * 30001, "python"), ("print(1)", "ruby")])
def test_input_validation(art_env, code, lang):
    with pytest.raises(ValueError):
        artifacts.run(code, lang)


def test_js_alias_maps_to_javascript(art_env):
    if not artifacts._node_path():
        pytest.skip("node not installed")
    r = artifacts.run("console.log('hi js')", "js")
    assert r["ok"] and "hi js" in r["stdout"]


def test_javascript_without_node(art_env, monkeypatch):
    monkeypatch.setattr(artifacts, "_node_path", lambda: None)
    with pytest.raises(ValueError, match="node"):
        artifacts.run("console.log(1)", "javascript")


def test_status_fields(art_env):
    st = artifacts.status()
    assert st["enabled"] is True and st["timeout"] == 30
    assert st["python"].endswith(".exe") or "python" in st["python"].lower()
    assert st["languages"] == ["python", "javascript", "html"]


def test_resolve_timeout_clamps():
    assert artifacts.resolve_timeout(500) == artifacts.MAX_TIMEOUT
    assert artifacts.resolve_timeout(0) == 1
    assert artifacts.resolve_timeout(None) == 30
    assert artifacts.resolve_timeout("garbage") == 30
