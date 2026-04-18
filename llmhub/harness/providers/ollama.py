import json
import logging
import requests
from .provider import Provider

logger = logging.getLogger(__name__)


class Ollama(Provider):
    def __init__(
        self,
        model: str,
        server_url: str = "http://localhost",
        port: str = "11434",
        max_iterations: int = 10,
    ):
        self.model = model
        self.port = port
        self.server_url = f"{server_url}:{port}"
        self.max_iterations = max_iterations
        super().__init__("ollama")

    def check_health(self) -> bool:
        """Check if the Ollama daemon is running."""
        try:
            response = requests.get(self.server_url, timeout=3)
            return response.status_code == 200
        except requests.exceptions.ConnectionError:
            logger.error("Ollama daemon is not running.")
            return False

    def generate(self, prompt: str, model: str = None, **kwargs) -> str:
        """Use the Ollama /api/generate endpoint for single-turn completion."""
        payload = {
            "model": model or self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "num_ctx": kwargs.get("num_ctx", 8192),
                "temperature": kwargs.get("temperature", 0.7),
            },
        }

        try:
            response = requests.post(f"{self.server_url}/api/generate", json=payload)
            response.raise_for_status()
            return response.json().get("response", "")
        except requests.exceptions.RequestException as e:
            logger.error("Ollama generation failed: %s", e)
            return ""

    def chat(self, messages: list[dict], tools: list = None, tool_map: dict = None, model: str = None, **kwargs) -> str:
        """Use the Ollama /api/chat endpoint with tool-call support."""
        payload = {
            "model": model or self.model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": kwargs.get("temperature", 0.7),
            },
        }
        if tools:
            payload["tools"] = tools

        try:
            response = requests.post(f"{self.server_url}/api/chat", json=payload)
            response.raise_for_status()
            msg = response.json()["message"]

            if not msg.get("tool_calls"):
                return msg.get("content", "")

            messages.append(msg)

            for i in range(self.max_iterations):
                for tool_call in msg["tool_calls"]:
                    name = tool_call["function"]["name"]
                    args = tool_call["function"]["arguments"]
                    if isinstance(args, str):
                        args = json.loads(args)

                    logger.debug("Calling tool %s with args %s", name, args)
                    if tool_map and name in tool_map:
                        tool_result = tool_map[name].invoke(args)
                    else:
                        tool_result = f"Error: tool '{name}' not found"

                    messages.append({
                        "role": "tool",
                        "content": str(tool_result),
                    })

                payload["messages"] = messages
                if i == self.max_iterations - 1:
                    payload.pop("tools", None)

                response = requests.post(f"{self.server_url}/api/chat", json=payload)
                response.raise_for_status()
                msg = response.json()["message"]

                if not msg.get("tool_calls"):
                    return msg.get("content") or ""

                messages.append(msg)

            return msg.get("content") or ""

        except (requests.exceptions.RequestException, KeyError, json.JSONDecodeError) as e:
            logger.error("Ollama chat failed: %s", e)
            return ""
