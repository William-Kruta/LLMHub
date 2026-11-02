"""Unit tests for server configuration persistence."""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from llmhub.models import CURRENT_SCHEMA_VERSION, ServerConfigCreate, ServerConfigUpdate


def test_list_configs_empty(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    assert cm.list_configs() == []


def test_create_config_persists(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    config = cm.create_config(
        ServerConfigCreate(name="Local Model", model_path="/models/local.gguf")
    )

    configs = cm.list_configs()
    assert len(configs) == 1
    assert configs[0].id == config.id
    assert configs[0].name == "Local Model"
    assert configs[0].port == 8080
    assert configs[0].created_at is not None
    assert configs[0].updated_at is not None


def test_update_config_partial(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    config = cm.create_config(
        ServerConfigCreate(name="Old", model_path="/models/local.gguf", port=8080)
    )

    updated = cm.update_config(config.id, ServerConfigUpdate(name="New"))

    assert updated is not None
    assert updated.name == "New"
    assert updated.port == 8080


def test_delete_config(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    config = cm.create_config(ServerConfigCreate(name="Temp", model_path="/tmp/m.gguf"))

    assert cm.delete_config(config.id) is True
    assert cm.get_config(config.id) is None
    assert cm.delete_config(config.id) is False


def test_duplicate_and_mark_started(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    config = cm.create_config(ServerConfigCreate(name="Base", model_path="/tmp/base.gguf"))

    duplicate = cm.duplicate_config(config.id)
    assert duplicate is not None
    assert duplicate.id != config.id
    assert duplicate.name == "Base Copy"
    assert duplicate.last_started_at is None

    started = cm.mark_started(config.id)
    assert started is not None
    assert started.last_started_at is not None
    assert started.last_used_at == started.last_started_at


def test_import_configs(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    imported = cm.import_configs([
        ServerConfigCreate(name="Imported", model_path="/tmp/imported.gguf", port=8099)
    ])

    assert len(imported) == 1
    assert imported[0].name == "Imported"
    assert cm.list_configs()[0].port == 8099


def test_env_vars_and_advanced_args_persist(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    config = cm.create_config(
        ServerConfigCreate(
            name="Advanced",
            model_path="/tmp/advanced.gguf",
            advanced_args=["--flash-attn"],
            env_vars={"CUDA_VISIBLE_DEVICES": "0"},
            preset="cuda-full",
        )
    )

    loaded = cm.get_config(config.id)
    assert loaded is not None
    assert loaded.schema_version == CURRENT_SCHEMA_VERSION
    assert loaded.advanced_args == ["--flash-attn"]
    assert loaded.env_vars == {"CUDA_VISIBLE_DEVICES": "0"}
    assert loaded.preset == "cuda-full"


def test_old_configs_migrate_with_unlimited_output(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    path = tmp_path / "config.json"
    monkeypatch.setattr(cm, "CONFIG_FILE", path)
    path.write_text(json.dumps({"old": {"id": "old", "name": "Old", "model_path": "/tmp/old.gguf", "schema_version": 2}}))

    assert cm.get_config("old").n_predict == -1
    saved = json.loads(path.read_text())["old"]
    assert saved["n_predict"] == -1
    assert saved["schema_version"] == CURRENT_SCHEMA_VERSION


def test_invalid_merged_config_is_never_written(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    path = tmp_path / "config.json"
    monkeypatch.setattr(cm, "CONFIG_FILE", path)
    config = cm.create_config(ServerConfigCreate(name="Valid", model_path="/tmp/model.gguf"))
    before = path.read_bytes()

    # Exercise persistence validation even if a caller bypasses request validation.
    with pytest.raises(ValidationError):
        cm.update_config(config.id, ServerConfigUpdate.model_construct(threads=None))

    assert path.read_bytes() == before
    assert cm.list_configs()[0].threads == 4


def test_concurrent_creates_preserve_every_config(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    original_read = cm._read_all
    start = threading.Barrier(8)

    def slow_read():
        snapshot = original_read()
        time.sleep(0.002)
        return snapshot

    monkeypatch.setattr(cm, "_read_all", slow_read)

    def worker(index):
        start.wait(timeout=5)
        return [cm.create_config(ServerConfigCreate(name=f"{index}-{n}", model_path="/tmp/model.gguf")).id for n in range(5)]

    with ThreadPoolExecutor(max_workers=8) as executor:
        created = list(executor.map(worker, range(8)))

    assert {config.id for config in cm.list_configs()} == {config_id for group in created for config_id in group}


def test_concurrent_edits_and_start_metadata_are_preserved(tmp_path, monkeypatch):
    import llmhub.config_manager as cm

    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    config = cm.create_config(ServerConfigCreate(name="Before", model_path="/tmp/model.gguf"))
    original_read = cm._read_all
    start = threading.Barrier(3)

    def slow_read():
        snapshot = original_read()
        time.sleep(0.01)
        return snapshot

    monkeypatch.setattr(cm, "_read_all", slow_read)
    operations = [
        lambda: cm.update_config(config.id, ServerConfigUpdate(name="After")),
        lambda: cm.update_config(config.id, ServerConfigUpdate(n_predict=256)),
        lambda: cm.mark_started(config.id),
    ]

    def worker(operation):
        start.wait(timeout=5)
        return operation()

    with ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(worker, operations))

    saved = cm.get_config(config.id)
    assert saved.name == "After"
    assert saved.n_predict == 256
    assert saved.last_started_at is not None
