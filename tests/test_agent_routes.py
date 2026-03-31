"""Integration tests for /api/agents API routes."""

import pytest
from fastapi.testclient import TestClient

from llmhub.server import app
import llmhub.agent_manager as am


@pytest.fixture(autouse=True)
def isolated_agent_file(tmp_path, monkeypatch):
    fake_file = tmp_path / "agents.json"
    monkeypatch.setattr(am, "AGENT_FILE", fake_file)
    yield fake_file


@pytest.fixture
def client():
    return TestClient(app)


def test_list_agents_empty(client):
    res = client.get("/api/agents")
    assert res.status_code == 200
    assert res.json() == []


def test_create_agent(client):
    res = client.post("/api/agents", json={"name": "Web Bot", "tools": ["web_search"], "soul_md_path": None})
    assert res.status_code == 201
    body = res.json()
    assert body["name"] == "Web Bot"
    assert body["tools"] == ["web_search"]
    assert "id" in body


def test_get_agent(client):
    created = client.post("/api/agents", json={"name": "Alpha", "tools": []}).json()
    res = client.get(f"/api/agents/{created['id']}")
    assert res.status_code == 200
    assert res.json()["name"] == "Alpha"


def test_get_agent_not_found(client):
    res = client.get("/api/agents/nonexistent")
    assert res.status_code == 404


def test_update_agent(client):
    created = client.post("/api/agents", json={"name": "Old", "tools": ["web_search"]}).json()
    res = client.put(f"/api/agents/{created['id']}", json={"name": "New"})
    assert res.status_code == 200
    assert res.json()["name"] == "New"
    assert res.json()["tools"] == ["web_search"]  # unchanged


def test_update_agent_not_found(client):
    res = client.put("/api/agents/ghost", json={"name": "X"})
    assert res.status_code == 404


def test_delete_agent(client):
    created = client.post("/api/agents", json={"name": "Temp", "tools": []}).json()
    res = client.delete(f"/api/agents/{created['id']}")
    assert res.status_code == 204
    # Confirm gone
    assert client.get(f"/api/agents/{created['id']}").status_code == 404


def test_delete_agent_not_found(client):
    res = client.delete("/api/agents/ghost")
    assert res.status_code == 404
