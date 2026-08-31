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


settings = Settings()
DATA_DIR.mkdir(parents=True, exist_ok=True)
VAULT_DIR.mkdir(parents=True, exist_ok=True)
