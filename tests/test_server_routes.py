"""Integration tests for the core server-management API."""

from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from llmhub.server import app
import llmhub.config_manager as cm
import llmhub.settings_manager as sm


@pytest.fixture(autouse=True)
def isolated_config_file(tmp_path, monkeypatch):
    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(sm, "SETTINGS_FILE", tmp_path / "settings.json")


@pytest.fixture
def client():
    return TestClient(app)


def test_config_crud_routes(client):
    created = client.post(
        "/api/configs",
        json={"name": "Test Server", "model_path": "/tmp/model.gguf", "port": 8090},
    )
    assert created.status_code == 201
    config_id = created.json()["config"]["id"]

    listed = client.get("/api/configs")
    assert listed.status_code == 200
    assert listed.json()[0]["config"]["name"] == "Test Server"
    assert listed.json()[0]["running"] is False

    updated = client.put(f"/api/configs/{config_id}", json={"name": "Renamed"})
    assert updated.status_code == 200
    assert updated.json()["config"]["name"] == "Renamed"
    assert updated.json()["config"]["port"] == 8090

    deleted = client.delete(f"/api/configs/{config_id}")
    assert deleted.status_code == 204
    assert client.get(f"/api/configs/{config_id}").status_code == 404


def test_cannot_update_or_delete_running_config(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Running", "model_path": "/tmp/model.gguf"},
    ).json()
    config_id = created["config"]["id"]
    monkeypatch.setattr("llmhub.server.process_manager.is_running", lambda _id: True)

    assert client.put(f"/api/configs/{config_id}", json={"name": "Blocked"}).status_code == 409
    assert client.delete(f"/api/configs/{config_id}").status_code == 409


def test_start_and_stop_routes(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Starter", "model_path": "/tmp/model.gguf"},
    ).json()
    config_id = created["config"]["id"]

    fake_server = Mock(pid=1234)
    running = {"value": False}

    def fake_start(_config):
        running["value"] = True
        return fake_server

    def fake_stop(_id):
        running["value"] = False
        return True

    monkeypatch.setattr("llmhub.server.process_manager.start", fake_start)
    monkeypatch.setattr("llmhub.server.process_manager.stop", fake_stop)
    monkeypatch.setattr("llmhub.server.process_manager.is_running", lambda _id: running["value"])
    monkeypatch.setattr("llmhub.server.process_manager.get_pid", lambda _id: 1234 if running["value"] else None)

    started = client.post(f"/api/configs/{config_id}/start")
    assert started.status_code == 200
    assert started.json()["running"] is True
    assert started.json()["pid"] == 1234

    stopped = client.post(f"/api/configs/{config_id}/stop")
    assert stopped.status_code == 200
    assert stopped.json()["running"] is False


def test_output_route(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Output", "model_path": "/tmp/model.gguf"},
    ).json()
    config_id = created["config"]["id"]

    monkeypatch.setattr("llmhub.server.process_manager.get_output", lambda _id, _offset: (["CUDA malloc failed: out of memory"], 1))
    monkeypatch.setattr("llmhub.server.process_manager.is_running", lambda _id: False)

    res = client.get(f"/api/configs/{config_id}/output?offset=0")
    assert res.status_code == 200
    assert res.json()["lines"] == ["CUDA malloc failed: out of memory"]
    assert res.json()["total"] == 1
    assert res.json()["offset"] == 0
    assert res.json()["running"] is False
    assert res.json()["annotations"][0]["title"] == "CUDA out of memory"


def test_validation_rejects_non_gguf_model(client):
    res = client.post(
        "/api/configs",
        json={"name": "Bad", "model_path": "/tmp/model.bin"},
    )
    assert res.status_code == 422


def test_validation_accepts_gguf_mmproj_path(client):
    res = client.post(
        "/api/configs",
        json={
            "name": "Vision",
            "model_path": "/tmp/model.gguf",
            "mmproj_path": "/tmp/mmproj.gguf",
        },
    )
    assert res.status_code == 201
    assert res.json()["config"]["mmproj_path"] == "/tmp/mmproj.gguf"


def test_duplicate_command_export_and_import(client):
    created = client.post(
        "/api/configs",
        json={
            "name": "Base",
            "model_path": "/tmp/model.gguf",
            "port": 8091,
            "extra_args": "--jinja",
        },
    ).json()
    config_id = created["config"]["id"]

    command = client.get(f"/api/configs/{config_id}/command")
    assert command.status_code == 200
    assert "--model /tmp/model.gguf" in command.json()["command_text"]
    assert "--jinja" in command.json()["command"]

    duplicate = client.post(f"/api/configs/{config_id}/duplicate")
    assert duplicate.status_code == 201
    assert duplicate.json()["config"]["id"] != config_id
    assert duplicate.json()["config"]["name"] == "Base Copy"

    exported = client.get("/api/configs/export")
    assert exported.status_code == 200
    assert len(exported.json()["configs"]) == 2

    single_export = client.get(f"/api/configs/{config_id}/export")
    assert single_export.status_code == 200
    assert single_export.json()["name"] == "Base"

    imported = client.post(
        "/api/configs/import",
        json={
            "configs": [
                {
                    "name": "Imported",
                    "model_path": "/tmp/imported.gguf",
                    "port": 8092,
                }
            ],
            "replace": False,
        },
    )
    assert imported.status_code == 200
    assert imported.json()[0]["config"]["name"] == "Imported"

    single_import = client.post(
        "/api/configs/import",
        json={"name": "Single", "model_path": "/tmp/single.gguf", "port": 8093},
    )
    assert single_import.status_code == 200
    assert single_import.json()[0]["config"]["name"] == "Single"

    array_import = client.post(
        "/api/configs/import",
        json=[{"name": "Array", "model_path": "/tmp/array.gguf", "port": 8094}],
    )
    assert array_import.status_code == 200
    assert array_import.json()[0]["config"]["name"] == "Array"


def test_clear_output_and_download_logs(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Logs", "model_path": "/tmp/model.gguf"},
    ).json()
    config_id = created["config"]["id"]

    monkeypatch.setattr("llmhub.server.process_manager.get_output", lambda _id, _offset: (["a", "b"], 2))
    monkeypatch.setattr("llmhub.server.process_manager.clear_output", lambda _id: True)

    cleared = client.post(f"/api/configs/{config_id}/output/clear")
    assert cleared.status_code == 200
    assert cleared.json() == {"status": "cleared"}

    logs = client.get(f"/api/configs/{config_id}/logs")
    assert logs.status_code == 200
    assert logs.text == "a\nb\n"


def test_presets_and_free_port(client):
    presets = client.get("/api/presets")
    assert presets.status_code == 200
    assert any(preset["id"] == "cpu" for preset in presets.json())

    free_port = client.get("/api/ports/free?host=127.0.0.1&start=50000")
    assert free_port.status_code == 200
    assert free_port.json()["port"] >= 50000


def test_gpu_route(client, monkeypatch):
    monkeypatch.setattr("llmhub.server.gpu_monitor.get_gpus", lambda: [])

    res = client.get("/api/gpus")

    assert res.status_code == 200
    assert res.json() == []


def test_ram_route(client, monkeypatch):
    monkeypatch.setattr("llmhub.server.ram_monitor.get_ram", lambda: None)

    res = client.get("/api/ram")

    assert res.status_code == 200
    assert res.json() is None


def test_settings_routes(client, tmp_path):
    defaults = client.get("/api/settings")
    assert defaults.status_code == 200
    assert defaults.json()["default_host"] == "127.0.0.1"

    updated = client.put(
        "/api/settings",
        json={
            "default_host": "0.0.0.0",
            "default_base_port": 9100,
            "default_threads": 12,
            "default_ctx_size": 8192,
            "default_n_gpu_layers": 20,
            "default_parallel": 2,
            "default_preset": "low-vram",
            "model_scan_directory": str(tmp_path),
            "refresh_interval_ms": 5000,
            "terminal_retention_lines": 500,
        },
    )
    assert updated.status_code == 200
    assert updated.json()["default_base_port"] == 9100
    assert client.get("/api/settings").json()["default_preset"] == "low-vram"


def test_scan_models(client, tmp_path):
    model = tmp_path / "model.gguf"
    mmproj = tmp_path / "model.mmproj"
    model.write_bytes(b"model")
    mmproj.write_bytes(b"proj")

    res = client.get(f"/api/models/scan?directory={tmp_path}")
    assert res.status_code == 200
    names = {item["name"] for item in res.json()}
    assert names == {"model.gguf", "model.mmproj"}


def test_endpoint_test(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Endpoint", "model_path": "/tmp/model.gguf"},
    ).json()
    config_id = created["config"]["id"]

    class FakeResponse:
        ok = True
        status_code = 200

        @staticmethod
        def json():
            return {"data": [{"id": "local-model"}]}

    monkeypatch.setattr("llmhub.server._requests.get", lambda *args, **kwargs: FakeResponse())

    res = client.post(f"/api/configs/{config_id}/test")
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert res.json()["models"] == ["local-model"]


def test_benchmark_endpoint(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Bench", "model_path": "/tmp/model.gguf", "port": 8095},
    ).json()
    config_id = created["config"]["id"]

    class FakeResponse:
        ok = True
        status_code = 200
        text = "ok"

        @staticmethod
        def json():
            return {"usage": {"prompt_tokens": 6, "completion_tokens": 4, "total_tokens": 10}}

    monkeypatch.setattr("llmhub.server._requests.post", lambda *args, **kwargs: FakeResponse())

    res = client.post(f"/api/configs/{config_id}/benchmark")
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert res.json()["latency_ms"] is not None
    assert res.json()["completion_tokens"] == 4
