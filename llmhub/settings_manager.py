"""Persistence for local LLM Hub UI/settings defaults."""

import json
import os
from pathlib import Path

from .models import AppSettings

SETTINGS_FILE = Path(__file__).parent / "settings.json"


def _settings_file() -> Path:
    data_dir = os.environ.get("LLMHUB_DATA_DIR")
    if data_dir:
        path = Path(data_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path / "settings.json"
    return SETTINGS_FILE


def get_settings() -> AppSettings:
    """Load app settings, returning defaults when none exist."""
    path = _settings_file()
    if not path.exists() or not path.read_text().strip():
        return AppSettings()
    try:
        return AppSettings(**json.loads(path.read_text()))
    except Exception:
        return AppSettings()


def update_settings(settings: AppSettings) -> AppSettings:
    """Persist app settings."""
    path = _settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings.model_dump(), indent=2))
    return settings
