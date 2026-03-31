"""Chat integration using LlamaCpp API and Memory management."""

import json
from typing import List, Dict

import requests

from kharness.providers import LlamaCpp as KHarnessLlamaCpp
from kharness.agent import Agent as KHarnessAgentBase
from kharness.memory import Memory as KHarnessMemory
from kharness.tools import WEB_TOOL_MAP, STOCK_TOOL_MAP

# All tools available for agent construction, keyed by individual tool name
_ALL_TOOLS: dict = {**WEB_TOOL_MAP, **STOCK_TOOL_MAP}


class Memory:
    """
    Manages a windowed conversation history for the plain LlamaCpp chat path.

    History is stored as a list of {"role": ..., "content": ...} dicts.

    Args:
        max_turns: Maximum number of *user/assistant turn pairs* to retain.
                   Older turns are dropped once the limit is exceeded.
                   The system prompt is always preserved.
    """

    def __init__(self, max_turns: int = 20):
        self.max_turns = max_turns
        self._messages: List[Dict[str, str]] = []

    def add(self, role: str, content: str) -> None:
        """Append a message and enforce the turn window."""
        self._messages.append({"role": role, "content": content})
        self._trim()

    def get_history(self) -> List[Dict[str, str]]:
        """Return a copy of current message history."""
        return list(self._messages)

    def clear(self) -> None:
        """Wipe all history."""
        self._messages.clear()

    def _trim(self) -> None:
        non_system = [m for m in self._messages if m["role"] != "system"]
        max_messages = self.max_turns * 2

        if len(non_system) > max_messages:
            overflow = len(non_system) - max_messages
            removed = 0
            kept = []
            for msg in self._messages:
                if msg["role"] != "system" and removed < overflow:
                    removed += 1
                else:
                    kept.append(msg)
            self._messages = kept

    def __len__(self) -> int:
        return len(self._messages)

    def __repr__(self) -> str:
        return f"Memory(turns={len(self._messages)}, max_turns={self.max_turns})"


class LlamaCpp:
    """Client for llama.cpp server's chat completion API."""

    def __init__(self, server_url: str = "http://localhost", port: int = 8080):
        self.port = port
        self.server_url = f"{server_url}:{port}"

    def _extract_content(self, msg: dict) -> str:
        """Extract text content from a message dict."""
        return msg.get("content") or ""

    def chat(self, messages: list[dict], tools: dict = None, tool_map: dict = None, **kwargs) -> str:
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]

        payload = {
            "messages": messages,
            "max_tokens": kwargs.get("max_tokens", 2048),
            "temperature": kwargs.get("temperature", 0.7),
        }

        if tools is not None:
            payload["tools"] = tools

        try:
            response = requests.post(
                f"{self.server_url}/v1/chat/completions",
                json=payload,
                timeout=120,
            )
            response.raise_for_status()
            result = response.json()
            msg = result["choices"][0]["message"]

            if not msg.get("tool_calls"):
                return self._extract_content(msg)

            messages.append(msg)

            max_iterations = 5
            strip_tools_after = 3

            for i in range(max_iterations):
                for tool_call in msg["tool_calls"]:
                    name = tool_call["function"]["name"]
                    args = tool_call["function"]["arguments"]
                    if isinstance(args, str):
                        args = json.loads(args)

                    print(f"🔧 Calling {name}({args})")
                    if tool_map and name in tool_map:
                        tool_result = tool_map[name].invoke(args)
                    else:
                        tool_result = f"Error: tool '{name}' not found"

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call["id"],
                        "content": str(tool_result),
                    })

                payload["messages"] = messages

                if i >= strip_tools_after - 1:
                    if "tools" in payload:
                        payload.pop("tools")
                        messages.append({
                            "role": "user",
                            "content": "Please provide your final answer based on the information gathered so far. Do not call any more tools.",
                        })

                response = requests.post(
                    f"{self.server_url}/v1/chat/completions",
                    json=payload,
                    timeout=120,
                )
                response.raise_for_status()
                result = response.json()
                msg = result["choices"][0]["message"]

                if not msg.get("tool_calls"):
                    return self._extract_content(msg)

                messages.append(msg)

            return self._extract_content(msg) or ""

        except (requests.exceptions.RequestException, KeyError, json.JSONDecodeError) as e:
            print(f"❌ Chat failed: {e}")
            raise RuntimeError(f"Chat failed: {e}")


# Global dictionary holding conversation memory per server config ID
_memories: dict[str, Memory] = {}


def get_memory(config_id: str) -> Memory:
    """Get or create a conversation memory for a specific server."""
    if config_id not in _memories:
        _memories[config_id] = Memory(max_turns=20)
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
