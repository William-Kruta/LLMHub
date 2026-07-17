"""Unit tests for shared JSON persistence helpers."""

import json
from pathlib import Path

from llmhub import storage


def test_data_file_honors_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("LLMHUB_DATA_DIR", str(tmp_path / "data"))

    path = storage.data_file(Path("/pkg/token_usage.json"))

    assert path == tmp_path / "data" / "token_usage.json"
    assert path.parent.is_dir()


def test_data_file_defaults_to_given_path(tmp_path, monkeypatch):
    monkeypatch.delenv("LLMHUB_DATA_DIR", raising=False)

    default = tmp_path / "config.json"
    assert storage.data_file(default) == default


def test_read_json_dict_missing_empty_and_non_dict(tmp_path):
    missing = tmp_path / "missing.json"
    assert storage.read_json_dict(missing) == {}

    empty = tmp_path / "empty.json"
    empty.write_text("   ")
    assert storage.read_json_dict(empty) == {}

    non_dict = tmp_path / "list.json"
    non_dict.write_text("[1, 2]")
    assert storage.read_json_dict(non_dict) == {}


def test_write_json_atomic_writes_and_leaves_no_temp_files(tmp_path):
    path = tmp_path / "data.json"

    storage.write_json_atomic(path, {"a": 1})
    storage.write_json_atomic(path, {"a": 2})

    assert json.loads(path.read_text()) == {"a": 2}
    assert [p.name for p in tmp_path.iterdir()] == ["data.json"]
