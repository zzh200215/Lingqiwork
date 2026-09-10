"""Sandbox every writable path before any app.* import runs.

app.config reads env at import time and app.db binds its engine to the result,
so the sandbox has to be wired at conftest import — test modules import app
modules at their own module level, which always happens after conftest.

This exists because the leak already happened once: tests created `dead`/`live`
ProviderConfig rows straight in the live data/workbench.db (found and removed
2026-09-08). With this conftest in place a test would have to work hard to
touch real user data; tests that need a *shaped* scratch set (backup, capture)
keep their own finer-grained monkeypatches on top.
"""
import os
import tempfile
from pathlib import Path

_SANDBOX = Path(tempfile.mkdtemp(prefix="wb-test-sandbox-"))

# A stray WB_* export from the shell must not defeat the sandbox.
for _name in (
    "WB_DATA_DIR",
    "WB_VAULT_DIR",
    "WB_DB_PATH",
    "WB_CONFIG_PATH",
    "WB_CHROMA_PATH",
):
    os.environ.pop(_name, None)

# db_path / config_path / chroma_path all derive from DATA_DIR, so one env var
# moves the database, config.json and the vector store together.
os.environ["WB_DATA_DIR"] = str(_SANDBOX / "data")
os.environ["WB_VAULT_DIR"] = str(_SANDBOX / "vault")
