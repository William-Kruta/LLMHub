"""CRUD operations for agent configurations, persisted to agents.json."""

import json
from pathlib import Path

from .models import AgentConfig, AgentConfigCreate, AgentConfigUpdate

AGENT_FILE = Path(__file__).parent / "agents.json"


def _read_all() -> dict[str, dict]:
    """Read raw agent dict from disk."""
    if not AGENT_FILE.exists():
        return {}
    text = AGENT_FILE.read_text()
    if not text.strip():
        return {}
    return json.loads(text)


def _write_all(data: dict[str, dict]) -> None:
    """Write agent dict to disk."""
    AGENT_FILE.write_text(json.dumps(data, indent=2))


def list_agents() -> list[AgentConfig]:
    """Return all saved agent configurations."""
    raw = _read_all()
    return [AgentConfig(**v) for v in raw.values()]


def get_agent(agent_id: str) -> AgentConfig | None:
    """Get a single agent configuration by ID."""
    raw = _read_all()
    if agent_id in raw:
        return AgentConfig(**raw[agent_id])
    return None


def create_agent(data: AgentConfigCreate) -> AgentConfig:
    """Create a new agent configuration and persist it."""
    agent = AgentConfig(**data.model_dump())
    raw = _read_all()
    raw[agent.id] = agent.model_dump()
    _write_all(raw)
    return agent


def update_agent(agent_id: str, data: AgentConfigUpdate) -> AgentConfig | None:
    """Update an existing agent configuration. Returns None if not found."""
    raw = _read_all()
    if agent_id not in raw:
        return None
    existing = raw[agent_id]
    updates = data.model_dump(exclude_unset=True)
    existing.update(updates)
    raw[agent_id] = existing
    _write_all(raw)
    return AgentConfig(**existing)


def delete_agent(agent_id: str) -> bool:
    """Delete an agent configuration. Returns True if deleted, False if not found."""
    raw = _read_all()
    if agent_id not in raw:
        return False
    del raw[agent_id]
    _write_all(raw)
    return True
