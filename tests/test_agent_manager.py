"""Unit tests for agent_manager CRUD operations."""

import json
import pytest
from pathlib import Path

from llmhub.models import AgentConfigCreate, AgentConfigUpdate


@pytest.fixture(autouse=True)
def isolated_agent_file(tmp_path, monkeypatch):
    """Point agent_manager at a temp file so tests don't touch the real agents.json."""
    import llmhub.agent_manager as am
    fake_file = tmp_path / "agents.json"
    monkeypatch.setattr(am, "AGENT_FILE", fake_file)
    yield fake_file


def test_list_agents_empty():
    from llmhub import agent_manager as am
    assert am.list_agents() == []


def test_create_agent_persists():
    from llmhub import agent_manager as am
    data = AgentConfigCreate(name="Test Agent", tools=["web_search"], soul_md_path=None)
    agent = am.create_agent(data)
    assert agent.name == "Test Agent"
    assert agent.tools == ["web_search"]
    assert agent.id  # UUID generated
    # Persisted to disk
    agents = am.list_agents()
    assert len(agents) == 1
    assert agents[0].id == agent.id


def test_get_agent_returns_none_for_missing():
    from llmhub import agent_manager as am
    assert am.get_agent("nonexistent-id") is None


def test_get_agent_returns_correct_agent():
    from llmhub import agent_manager as am
    data = AgentConfigCreate(name="Finder", tools=[], soul_md_path="/tmp/soul.md")
    agent = am.create_agent(data)
    found = am.get_agent(agent.id)
    assert found is not None
    assert found.name == "Finder"
    assert found.soul_md_path == "/tmp/soul.md"


def test_update_agent_partial():
    from llmhub import agent_manager as am
    agent = am.create_agent(AgentConfigCreate(name="Old Name", tools=["web_search"]))
    updated = am.update_agent(agent.id, AgentConfigUpdate(name="New Name"))
    assert updated is not None
    assert updated.name == "New Name"
    assert updated.tools == ["web_search"]  # unchanged


def test_update_agent_returns_none_for_missing():
    from llmhub import agent_manager as am
    result = am.update_agent("bad-id", AgentConfigUpdate(name="X"))
    assert result is None


def test_delete_agent_removes_entry():
    from llmhub import agent_manager as am
    agent = am.create_agent(AgentConfigCreate(name="Bye", tools=[]))
    assert am.delete_agent(agent.id) is True
    assert am.list_agents() == []


def test_delete_agent_returns_false_for_missing():
    from llmhub import agent_manager as am
    assert am.delete_agent("ghost-id") is False
