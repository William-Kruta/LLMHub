"""Persistence for local LLM Hub UI/settings defaults."""

from pathlib import Path

from . import storage
from .models import AppSettings

SETTINGS_FILE = Path(__file__).parent / "settings.json"


def _settings_file() -> Path:
    return storage.data_file(SETTINGS_FILE)


def get_settings() -> AppSettings:
    """Load app settings, returning defaults when none exist."""
    try:
        raw = storage.read_json_dict(_settings_file())
        return AppSettings(**raw) if raw else AppSettings()
    except Exception:
        return AppSettings()


def update_settings(settings: AppSettings) -> AppSettings:
    """Persist app settings."""
    path = _settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    storage.write_json_atomic(path, settings.model_dump())
    return settings
