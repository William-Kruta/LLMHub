"""Chat integration using LlamaCpp API and Memory management."""

import json
from typing import List, Dict

import requests

from kharness.providers import LlamaCpp as KHarnessLlamaCpp
from kharness.agent import Agent as KHarnessAgentBase
from kharness.memory import Memory as KHarnessMemory
from kharness.memory import Memory
from kharness.tools import WEB_TOOL_MAP, STOCK_TOOL_MAP

# All tools available for agent construction, keyed by individual tool name
_ALL_TOOLS: dict = {**WEB_TOOL_MAP, **STOCK_TOOL_MAP}


# Global dictionary holding conversation memory per server config ID
_memories: dict[str, Memory] = {}


def get_memory(config_id: str) -> KHarnessMemory:
    """Get or create a conversation memory for a specific server."""
    if config_id not in _memories:
        _memories[config_id] = KHarnessMemory(max_turns=20)
    return _memories[config_id]


def clear_memory(config_id: str) -> None:
    """Clear memory for a specific server."""
    if config_id in _memories:
        _memories[config_id].clear()


class KHarnessAgent:
    """KHarness Agent backed by a LlamaCpp provider, with configurable tools and soul."""

    def __init__(
        self,
        server_url: str = "http://127.0.0.1",
        port: int = 8080,
        tool_names: list[str] | None = None,
        soul_md_path: str | None = None,
    ):
        provider = KHarnessLlamaCpp(server_url=server_url, port=str(port))
        self._memory = KHarnessMemory(max_turns=20)

        # Build tool_map from selected tool names; unknown names are silently skipped
        tool_map = {name: _ALL_TOOLS[name] for name in (tool_names or []) if name in _ALL_TOOLS} or None

        self._agent = KHarnessAgentBase(
            provider=provider,
            memory=self._memory,
            tool_map=tool_map,
            soul_md_path=soul_md_path,
        )

    def run(self, user_input: str, **kwargs) -> str:
        return self._agent.run(user_input, **kwargs)

    def get_history(self) -> list:
        return self._memory.get_history()

    def clear(self) -> None:
        self._memory.clear()


# Cache keyed by (server_config_id, agent_id) → KHarnessAgent instance
_kharness_agents: dict[tuple[str, str], KHarnessAgent] = {}


def get_kharness_agent(
    config_id: str,
    agent_id: str,
    server_url: str,
    port: int,
    tool_names: list[str],
    soul_md_path: str | None,
) -> KHarnessAgent:
    """Get or create a KHarness agent for a specific (server, agent config) pair."""
    key = (config_id, agent_id)
    if key not in _kharness_agents:
        _kharness_agents[key] = KHarnessAgent(
            server_url=server_url,
            port=port,
            tool_names=tool_names,
            soul_md_path=soul_md_path,
        )
    return _kharness_agents[key]


def clear_kharness_agent(agent_id: str) -> None:
    """Remove all cached agents for a given agent_id (called on agent update/delete)."""
    stale = [key for key in _kharness_agents if key[1] == agent_id]
    for key in stale:
        del _kharness_agents[key]


def clear_kharness_agents_for_server(config_id: str) -> None:
    """Remove all cached agents for a given server config (called on Clear Chat)."""
    stale = [key for key in _kharness_agents if key[0] == config_id]
    for key in stale:
        del _kharness_agents[key]
