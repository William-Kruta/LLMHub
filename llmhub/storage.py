"""Shared persistence helpers for LLM Hub JSON data files."""

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def now_iso() -> str:
    """Current UTC time as an ISO string."""
    return datetime.now(timezone.utc).isoformat()


def data_file(default_path: Path) -> Path:
    """Resolve a data file path, honoring LLMHUB_DATA_DIR when set."""
    data_dir = os.environ.get("LLMHUB_DATA_DIR")
    if data_dir:
        path = Path(data_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path / default_path.name
    return default_path


def read_json_dict(path: Path) -> dict:
    """Read a JSON object from disk. Missing, empty, or non-dict files yield {}.

    Invalid JSON raises; callers decide whether corruption is recoverable.
    """
    if not path.exists():
        return {}
    text = path.read_text()
    if not text.strip():
        return {}
    raw = json.loads(text)
    return raw if isinstance(raw, dict) else {}


def write_json_atomic(path: Path, data: dict) -> None:
    """Write JSON via a temp file and atomic rename so readers never see partial content."""
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(json.dumps(data, indent=2))
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
