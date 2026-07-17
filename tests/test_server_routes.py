"""Integration tests for the core server-management API."""

from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from llmhub.server import app
import llmhub.config_manager as cm
import llmhub.settings_manager as sm
import llmhub.token_tracker as tt


@pytest.fixture(autouse=True)
def isolated_config_file(tmp_path, monkeypatch):
    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(sm, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")


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

    listed = client.get("/api/configs")
    assert listed.json()[0]["token_usage"]["prompt_tokens"] == 6
    assert listed.json()[0]["token_usage"]["completion_tokens"] == 4
    assert listed.json()[0]["token_usage"]["total_tokens"] == 10
    assert listed.json()[0]["token_usage"]["request_count"] == 1


def test_completion_proxy_tracks_token_usage(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Proxy", "model_path": "/tmp/model.gguf", "port": 8096},
    ).json()
    config_id = created["config"]["id"]
    captured = {}

    class FakeResponse:
        ok = True
        status_code = 200
        content = b'{"id":"cmpl","usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}'
        headers = {"content-type": "application/json"}

        @staticmethod
        def json():
            return {"usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12}}

    def fake_request(method, url, **kwargs):
        captured["method"] = method
        captured["url"] = url
        captured["data"] = kwargs["data"]
        return FakeResponse()

    monkeypatch.setattr("llmhub.server._requests.request", fake_request)

    res = client.post(
        f"/api/configs/{config_id}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}]},
    )

    assert res.status_code == 200
    assert captured["method"] == "POST"
    assert captured["url"] == "http://127.0.0.1:8096/v1/chat/completions"
    assert b"messages" in captured["data"]

    usage = client.get(f"/api/configs/{config_id}/tokens")
    assert usage.status_code == 200
    assert usage.json()["prompt_tokens"] == 7
    assert usage.json()["completion_tokens"] == 5
    assert usage.json()["total_tokens"] == 12
    assert usage.json()["request_count"] == 1


def test_proxy_forwards_get_v1_models(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Models Proxy", "model_path": "/tmp/model.gguf", "port": 8097},
    ).json()
    config_id = created["config"]["id"]
    captured = {}

    class FakeResponse:
        ok = True
        status_code = 200
        content = b'{"data":[{"id":"local-model"}]}'
        headers = {"content-type": "application/json"}

        @staticmethod
        def json():
            return {"data": [{"id": "local-model"}]}

    def fake_request(method, url, **kwargs):
        captured["method"] = method
        captured["url"] = url
        return FakeResponse()

    monkeypatch.setattr("llmhub.server._requests.request", fake_request)

    res = client.get(f"/api/configs/{config_id}/v1/models")

    assert res.status_code == 200
    assert res.json()["data"][0]["id"] == "local-model"
    assert captured["method"] == "GET"
    assert captured["url"] == "http://127.0.0.1:8097/v1/models"


def test_proxy_streaming_records_usage(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Stream Proxy", "model_path": "/tmp/model.gguf", "port": 8098},
    ).json()
    config_id = created["config"]["id"]

    chunks = [
        b'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        b'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}\n\n',
        b"data: [DONE]\n\n",
    ]

    class FakeStreamResponse:
        ok = True
        status_code = 200
        headers = {"content-type": "text/event-stream"}

        @staticmethod
        def iter_content(chunk_size=None):
            yield from chunks

        @staticmethod
        def close():
            pass

    monkeypatch.setattr("llmhub.server._requests.request", lambda *args, **kwargs: FakeStreamResponse())

    res = client.post(
        f"/api/configs/{config_id}/v1/chat/completions",
        json={"stream": True, "messages": [{"role": "user", "content": "hi"}]},
    )

    assert res.status_code == 200
    assert b"[DONE]" in res.content

    usage = client.get(f"/api/configs/{config_id}/tokens").json()
    assert usage["prompt_tokens"] == 9
    assert usage["completion_tokens"] == 3
    assert usage["total_tokens"] == 12
    assert usage["request_count"] == 1


def test_proxy_accepts_non_utf8_body(monkeypatch, tmp_path):
    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(sm, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")
    tolerant_client = TestClient(app, raise_server_exceptions=False)

    created = tolerant_client.post(
        "/api/configs",
        json={"name": "Raw Proxy", "model_path": "/tmp/model.gguf", "port": 8099},
    ).json()
    config_id = created["config"]["id"]

    class FakeResponse:
        ok = True
        status_code = 200
        content = b'{"ok":true}'
        headers = {"content-type": "application/json"}

        @staticmethod
        def json():
            return {"ok": True}

    monkeypatch.setattr("llmhub.server._requests.request", lambda *args, **kwargs: FakeResponse())

    res = tolerant_client.post(
        f"/api/configs/{config_id}/v1/completions",
        content=b"\xff\xfe not utf-8",
        headers={"content-type": "application/json"},
    )

    assert res.status_code == 200


def test_proxy_does_not_block_other_requests(monkeypatch):
    import threading
    import time as _time

    class FakeResponse:
        ok = True
        status_code = 200
        content = b'{"ok":true}'
        headers = {"content-type": "application/json"}

        @staticmethod
        def json():
            return {"ok": True}

    def slow_upstream(*args, **kwargs):
        _time.sleep(1.5)
        return FakeResponse()

    monkeypatch.setattr("llmhub.server._requests.post", slow_upstream)
    monkeypatch.setattr("llmhub.server._requests.request", slow_upstream)

    # A context-managed TestClient shares one event loop across requests,
    # so a handler that blocks the loop stalls the concurrent request below.
    with TestClient(app) as shared:
        created = shared.post(
            "/api/configs",
            json={"name": "Slow Proxy", "model_path": "/tmp/model.gguf", "port": 8100},
        ).json()
        config_id = created["config"]["id"]

        proxy_result = {}

        def call_proxy():
            proxy_result["response"] = shared.post(
                f"/api/configs/{config_id}/v1/chat/completions",
                json={"messages": [{"role": "user", "content": "hi"}]},
            )

        thread = threading.Thread(target=call_proxy)
        thread.start()
        _time.sleep(0.3)

        started = _time.perf_counter()
        res = shared.get("/api/presets")
        elapsed = _time.perf_counter() - started
        thread.join()

    assert res.status_code == 200
    assert proxy_result["response"].status_code == 200
    assert elapsed < 1.0, f"event loop blocked for {elapsed:.2f}s while proxying"


def test_configs_list_survives_corrupt_token_usage_file(client, tmp_path):
    client.post(
        "/api/configs",
        json={"name": "Corrupt Usage", "model_path": "/tmp/model.gguf"},
    )
    (tmp_path / "token_usage.json").write_text("{broken json")

    res = client.get("/api/configs")

    assert res.status_code == 200
    assert res.json()[0]["token_usage"]["total_tokens"] == 0


def test_delete_config_survives_corrupt_token_usage_file(client, tmp_path):
    created = client.post(
        "/api/configs",
        json={"name": "Corrupt Delete", "model_path": "/tmp/model.gguf"},
    ).json()
    config_id = created["config"]["id"]
    (tmp_path / "token_usage.json").write_text("{broken json")

    assert client.delete(f"/api/configs/{config_id}").status_code == 204
    assert client.get(f"/api/configs/{config_id}").status_code == 404


def test_benchmark_survives_tracker_failure(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Bench Guard", "model_path": "/tmp/model.gguf", "port": 8101},
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

    def boom(*args, **kwargs):
        raise RuntimeError("tracker down")

    monkeypatch.setattr(tt, "record_response_usage", boom)

    res = client.post(f"/api/configs/{config_id}/benchmark")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert res.json()["completion_tokens"] == 4


def test_replace_import_resets_token_usage(client):
    first = client.post(
        "/api/configs",
        json={"name": "Keep Import", "model_path": "/tmp/model.gguf", "port": 8102},
    ).json()
    second = client.post(
        "/api/configs",
        json={"name": "Drop Import", "model_path": "/tmp/model.gguf", "port": 8103},
    ).json()
    first_id = first["config"]["id"]
    second_id = second["config"]["id"]
    tt.record_usage(first_id, prompt_tokens=5, completion_tokens=5)
    tt.record_usage(second_id, prompt_tokens=7, completion_tokens=7)

    exported = client.get(f"/api/configs/{first_id}/export").json()
    res = client.post("/api/configs/import", json={"configs": [exported], "replace": True})

    assert res.status_code == 200
    assert res.json()[0]["config"]["id"] == first_id
    assert tt.get_usage(first_id).request_count == 0
    assert tt.get_usage(second_id).request_count == 0


def test_list_configs_reads_usage_file_once(client, monkeypatch):
    for index in range(3):
        client.post(
            "/api/configs",
            json={"name": f"Poll {index}", "model_path": "/tmp/model.gguf", "port": 8110 + index},
        )

    calls = {"count": 0}
    original = tt._read_all

    def counting_read_all():
        calls["count"] += 1
        return original()

    monkeypatch.setattr(tt, "_read_all", counting_read_all)

    res = client.get("/api/configs")

    assert res.status_code == 200
    assert len(res.json()) == 3
    assert calls["count"] == 1


def test_reset_token_usage(client, monkeypatch):
    created = client.post(
        "/api/configs",
        json={"name": "Reset Usage", "model_path": "/tmp/model.gguf"},
    ).json()
    config_id = created["config"]["id"]
    tt.record_usage(config_id, prompt_tokens=3, completion_tokens=2)

    reset = client.post(f"/api/configs/{config_id}/tokens/reset")
    assert reset.status_code == 200
    assert reset.json()["prompt_tokens"] == 0
    assert client.get(f"/api/configs/{config_id}/tokens").json()["total_tokens"] == 0
