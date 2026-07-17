"""Persistent per-configuration token usage counters."""

import threading
from collections.abc import Iterable
from pathlib import Path

from . import storage
from .models import TokenUsage

TOKEN_USAGE_FILE = Path(__file__).parent / "token_usage.json"

# Serializes read-modify-write cycles; concurrent recorders otherwise lose counts.
_LOCK = threading.Lock()


def _usage_file() -> Path:
    return storage.data_file(TOKEN_USAGE_FILE)


def _read_all() -> dict[str, dict]:
    try:
        return storage.read_json_dict(_usage_file())
    except Exception:
        # Counters are best-effort telemetry; a corrupt file must never break the app.
        return {}


def _write_all(data: dict[str, dict]) -> None:
    storage.write_json_atomic(_usage_file(), data)


def _usage_from_raw(raw: dict | None) -> TokenUsage:
    try:
        return TokenUsage(**(raw or {}))
    except Exception:
        return TokenUsage()


def _as_nonnegative_int(value) -> int | None:
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, number)


def get_usage(config_id: str) -> TokenUsage:
    """Return aggregate usage for one config."""
    return _usage_from_raw(_read_all().get(config_id))


def get_all_usage() -> dict[str, TokenUsage]:
    """Return aggregate usage for all configs in one file read."""
    return {config_id: _usage_from_raw(raw) for config_id, raw in _read_all().items()}


def record_usage(
    config_id: str,
    *,
    prompt_tokens=None,
    completion_tokens=None,
    total_tokens=None,
) -> TokenUsage:
    """Add one response's token usage to a config aggregate."""
    prompt = _as_nonnegative_int(prompt_tokens)
    completion = _as_nonnegative_int(completion_tokens)
    total = _as_nonnegative_int(total_tokens)
    if total is None and (prompt is not None or completion is not None):
        total = (prompt or 0) + (completion or 0)

    if prompt is None and completion is None and total is None:
        return get_usage(config_id)

    with _LOCK:
        raw = _read_all()
        current = _usage_from_raw(raw.get(config_id))
        updated = TokenUsage(
            prompt_tokens=current.prompt_tokens + (prompt or 0),
            completion_tokens=current.completion_tokens + (completion or 0),
            total_tokens=current.total_tokens + (total or 0),
            request_count=current.request_count + 1,
            last_used_at=storage.now_iso(),
        )
        raw[config_id] = updated.model_dump()
        _write_all(raw)
    return updated


def record_response_usage(config_id: str, response_json: dict) -> TokenUsage:
    """Record an OpenAI-compatible response usage object when present."""
    usage = response_json.get("usage") if isinstance(response_json, dict) else None
    if not isinstance(usage, dict):
        return get_usage(config_id)
    return record_usage(
        config_id,
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
        total_tokens=usage.get("total_tokens"),
    )


def reset_usage(config_id: str) -> TokenUsage:
    """Reset aggregate usage for one config."""
    reset_many([config_id])
    return TokenUsage()


def reset_many(config_ids: Iterable[str]) -> None:
    """Reset aggregate usage for several configs at once."""
    ids = set(config_ids)
    with _LOCK:
        raw = _read_all()
        remaining = {key: value for key, value in raw.items() if key not in ids}
        if len(remaining) != len(raw):
            _write_all(remaining)
