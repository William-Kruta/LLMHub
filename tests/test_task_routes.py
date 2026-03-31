"""Integration tests for /api/tasks routes."""

import json
import queue
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from llmhub.server import app
import llmhub.agent_manager as am
import llmhub.config_manager as cm
import llmhub.task_runner as tr


@pytest.fixture(autouse=True)
def isolated_files(tmp_path, monkeypatch):
    monkeypatch.setattr(am, "AGENT_FILE", tmp_path / "agents.json")
    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "configs.json")
    monkeypatch.setattr(tr, "RESULTS_FILE", tmp_path / "results.json")
    # Clear in-memory run state between tests
    tr._runs.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def running_server(client):
    """Creates a config and fakes it as running."""
    config = client.post("/api/configs", json={
        "name": "Test Server",
        "model_path": "/tmp/model.gguf",
        "host": "127.0.0.1",
        "port": 8080,
    }).json()
    config_id = config["config"]["id"]
    with patch("llmhub.server.process_manager.is_running", return_value=True):
        yield config_id


@pytest.fixture
def agent_id(client):
    agent = client.post("/api/agents", json={"name": "Researcher", "tools": []}).json()
    return agent["id"]


def test_run_task_returns_run_id(client, running_server, agent_id, monkeypatch):
    monkeypatch.setattr(tr, "start_run", lambda **kwargs: "fake-run-id")
    res = client.post("/api/tasks/run", data={
        "agent_id": agent_id,
        "config_id": running_server,
    }, files={"file": ("task.md", b"# Do research", "text/markdown")})
    assert res.status_code == 200
    assert res.json()["run_id"] == "fake-run-id"


def test_run_task_missing_agent(client, running_server):
    res = client.post("/api/tasks/run", data={
        "agent_id": "ghost-agent",
        "config_id": running_server,
    }, files={"file": ("task.md", b"# Research", "text/markdown")})
    assert res.status_code == 400
    assert "Agent not found" in res.json()["detail"]


def test_run_task_server_not_running(client, agent_id):
    config = client.post("/api/configs", json={
        "name": "Offline",
        "model_path": "/tmp/model.gguf",
    }).json()
    config_id = config["config"]["id"]
    res = client.post("/api/tasks/run", data={
        "agent_id": agent_id,
        "config_id": config_id,
    }, files={"file": ("task.md", b"# Research", "text/markdown")})
    assert res.status_code == 400
    assert "not running" in res.json()["detail"]


def test_stream_unknown_run_id(client):
    with client.stream("GET", "/api/tasks/unknown-run/stream") as res:
        assert res.status_code == 200
        res.read()
        content = res.text
    assert '"type": "error"' in content


def test_stream_delivers_events(client, monkeypatch):
    run_id = "test-stream-run"
    q = queue.Queue()
    q.put({"type": "phase", "text": "Searching..."})
    q.put({"type": "complete", "report": "# Result"})
    tr._runs[run_id] = {"status": "complete", "queue": q, "result": None}

    with client.stream("GET", f"/api/tasks/{run_id}/stream") as res:
        assert res.status_code == 200
        res.read()
        content = res.text

    lines = [l for l in content.strip().split("\n") if l.startswith("data:")]
    assert len(lines) == 2
    first = json.loads(lines[0].removeprefix("data: "))
    assert first == {"type": "phase", "text": "Searching..."}


def test_history_empty(client):
    res = client.get("/api/tasks/history")
    assert res.status_code == 200
    assert res.json() == []


def test_history_returns_results(client, monkeypatch):
    from llmhub.models import TaskResult
    r = TaskResult(
        agent_id="a1", config_id="c1", filename="f.md",
        started_at="2026-03-31T10:00:00", completed_at="2026-03-31T10:01:00",
        status="complete", report="# Done"
    )
    tr._save_result(r)
    res = client.get("/api/tasks/history")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["filename"] == "f.md"
