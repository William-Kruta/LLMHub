"""CRUD operations for server configurations, persisted to config.json."""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .models import CURRENT_SCHEMA_VERSION, ServerConfig, ServerConfigCreate, ServerConfigUpdate

CONFIG_FILE = Path(__file__).parent / "config.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _config_file() -> Path:
    data_dir = os.environ.get("LLMHUB_DATA_DIR")
    if data_dir:
        path = Path(data_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path / "config.json"
    return CONFIG_FILE


def _read_all() -> dict[str, dict]:
    """Read raw config dict from disk."""
    config_file = _config_file()
    if not config_file.exists():
        return {}
    text = config_file.read_text()
    if not text.strip():
        return {}
    raw = json.loads(text)
    changed = False
    for key, value in list(raw.items()):
        migrated, did_change = _migrate_config(value)
        raw[key] = migrated
        changed = changed or did_change
    if changed:
        _write_all(raw)
    return raw


def _migrate_config(data: dict) -> tuple[dict, bool]:
    """Migrate older config dictionaries to the current schema."""
    migrated = dict(data)
    changed = False
    defaults = {
        "schema_version": CURRENT_SCHEMA_VERSION,
        "advanced_args": [],
        "env_vars": {},
        "preset": "custom",
        "created_at": None,
        "updated_at": None,
        "last_started_at": None,
        "last_used_at": None,
    }
    for key, value in defaults.items():
        if key not in migrated:
            migrated[key] = value
            changed = True

    if migrated.get("schema_version") != CURRENT_SCHEMA_VERSION:
        migrated["schema_version"] = CURRENT_SCHEMA_VERSION
        changed = True

    return migrated, changed


def _write_all(data: dict[str, dict]) -> None:
    """Write config dict to disk."""
    _config_file().write_text(json.dumps(data, indent=2))


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
    now = _now()
    config = ServerConfig(**data.model_dump(), schema_version=CURRENT_SCHEMA_VERSION, created_at=now, updated_at=now)
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
    existing["updated_at"] = _now()
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


def duplicate_config(config_id: str) -> ServerConfig | None:
    """Copy a configuration and persist it with a fresh ID."""
    config = get_config(config_id)
    if not config:
        return None

    now = _now()
    data = config.model_dump()
    data["id"] = str(uuid.uuid4())
    data["schema_version"] = CURRENT_SCHEMA_VERSION
    data["name"] = f"{config.name} Copy"
    data["created_at"] = now
    data["updated_at"] = now
    data["last_started_at"] = None
    data["last_used_at"] = None

    duplicate = ServerConfig(**data)
    raw = _read_all()
    raw[duplicate.id] = duplicate.model_dump()
    _write_all(raw)
    return duplicate


def mark_started(config_id: str) -> ServerConfig | None:
    """Record that a config was started or otherwise used."""
    raw = _read_all()
    if config_id not in raw:
        return None
    now = _now()
    raw[config_id]["last_started_at"] = now
    raw[config_id]["last_used_at"] = now
    _write_all(raw)
    return ServerConfig(**raw[config_id])


def replace_configs(configs: list[ServerConfig]) -> list[ServerConfig]:
    """Replace all saved configurations."""
    data = {config.id: config.model_dump() for config in configs}
    _write_all(data)
    return configs


def import_configs(configs: list[ServerConfig | ServerConfigCreate], replace: bool = False) -> list[ServerConfig]:
    """Import configurations, assigning IDs and timestamps when needed."""
    raw = {} if replace else _read_all()
    imported: list[ServerConfig] = []

    for item in configs:
        now = _now()
        data = item.model_dump()
        data.setdefault("id", str(uuid.uuid4()))
        if not data.get("id") or data["id"] in raw:
            data["id"] = str(uuid.uuid4())
        data.setdefault("created_at", now)
        data["schema_version"] = CURRENT_SCHEMA_VERSION
        data["updated_at"] = now
        data.setdefault("last_started_at", None)
        data.setdefault("last_used_at", None)
        config = ServerConfig(**data)
        raw[config.id] = config.model_dump()
        imported.append(config)

    _write_all(raw)
    return imported
