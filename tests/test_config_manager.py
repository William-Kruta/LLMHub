"""Unit tests for server configuration persistence."""

from llmhub.models import ServerConfigCreate, ServerConfigUpdate


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
    assert loaded.schema_version == 2
    assert loaded.advanced_args == ["--flash-attn"]
    assert loaded.env_vars == {"CUDA_VISIBLE_DEVICES": "0"}
    assert loaded.preset == "cuda-full"
