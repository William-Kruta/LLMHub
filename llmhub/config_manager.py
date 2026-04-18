"""CRUD operations for server configurations, persisted to config.json."""

import json
from pathlib import Path

from .models import ServerConfig, ServerConfigCreate, ServerConfigUpdate

CONFIG_FILE = Path(__file__).parent / "config.json"


def _read_all() -> dict[str, dict]:
    """Read raw config dict from disk."""
    if not CONFIG_FILE.exists():
        return {}
    text = CONFIG_FILE.read_text()
    if not text.strip():
        return {}
    return json.loads(text)


def _write_all(data: dict[str, dict]) -> None:
    """Write config dict to disk."""
    CONFIG_FILE.write_text(json.dumps(data, indent=2))


def list_configs() -> list[ServerConfig]:
    """Return all saved configurations."""
    raw = _read_all()
    return [ServerConfig(**v) for v in raw.values()]


def get_config(config_id: str) -> ServerConfig | None:
    """Get a single configuration by ID."""
    raw = _read_all()
    if config_id in raw:
        return ServerConfig(**raw[config_id])
    return None


def create_config(data: ServerConfigCreate) -> ServerConfig:
    """Create a new configuration and persist it."""
    config = ServerConfig(**data.model_dump())
    raw = _read_all()
    raw[config.id] = config.model_dump()
    _write_all(raw)
    return config


def update_config(config_id: str, data: ServerConfigUpdate) -> ServerConfig | None:
    """Update an existing configuration. Returns None if not found."""
    raw = _read_all()
    if config_id not in raw:
        return None
    existing = raw[config_id]
    updates = data.model_dump(exclude_unset=True)
    existing.update(updates)
    raw[config_id] = existing
    _write_all(raw)
    return ServerConfig(**existing)


def delete_config(config_id: str) -> bool:
    """Delete a configuration. Returns True if deleted, False if not found."""
    raw = _read_all()
    if config_id not in raw:
        return False
    del raw[config_id]
    _write_all(raw)
    return True
