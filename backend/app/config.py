"""Application configuration via pydantic-settings.

Config file lives in `data/config.json` next to the database so everything
is contained in one data directory.
"""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # project root D:\TP\A
DATA_DIR = BASE_DIR / "data"
VAULT_DIR = BASE_DIR / "vault"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WB_", env_file=None)

    app_name: str = "AI Workbench"
    db_path: Path = DATA_DIR / "workbench.db"
    config_path: Path = DATA_DIR / "config.json"
    # Overridable for the same reason db_path is: the restore drill (PLAN.md 第 8 节)
    # has to rebuild an index from a restored vault, and a hard-coded path would
    # make the rehearsal overwrite the live one. Not a user-facing setting.
    chroma_path: Path = DATA_DIR / "chroma"


settings = Settings()
DATA_DIR.mkdir(parents=True, exist_ok=True)
VAULT_DIR.mkdir(parents=True, exist_ok=True)
