"""Application configuration via pydantic-settings.

Config file lives in `data/config.json` next to the database so everything
is contained in one data directory.

Every directory is overridable via env (WB_DATA_DIR / WB_VAULT_DIR): the test
suite points them at a sandbox (tests/conftest.py) so a stray test can never
write into the real data/ and vault/ trees again — the `dead`/`live` provider
rows found in the live DB on 2026-09-08 were exactly that kind of leak.
"""
import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # project root D:\TP\A


def _env_dir(name: str, default: Path) -> Path:
    return Path(os.environ.get(name) or default)


DATA_DIR = _env_dir("WB_DATA_DIR", BASE_DIR / "data")
VAULT_DIR = _env_dir("WB_VAULT_DIR", BASE_DIR / "vault")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WB_", env_file=None)

    app_name: str = "AI Workbench"
    db_path: Path = DATA_DIR / "workbench.db"
    config_path: Path = DATA_DIR / "config.json"
    # Overridable for the same reason db_path is: the restore drill
    # has to rebuild an index from a restored vault, and a hard-coded path would
    # make the rehearsal overwrite the live one. Not a user-facing setting.
    chroma_path: Path = DATA_DIR / "chroma"


settings = Settings()
DATA_DIR.mkdir(parents=True, exist_ok=True)
VAULT_DIR.mkdir(parents=True, exist_ok=True)
