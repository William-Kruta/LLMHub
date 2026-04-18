import re
import json
import logging
import requests
from .provider import Provider

logger = logging.getLogger(__name__)


class LlamaCpp(Provider):
    def __init__(
        self,
        server_url: str = "http://127.0.0.1",
        port: str = "8080",
        max_iterations: int = 5,
        strip_tools_after: int = 3,
    ):
        self.port = port
        self.server_url = f"{server_url}:{port}"
        self.max_iterations = max_iterations
        self.strip_tools_after = strip_tools_after
        super().__init__("llamacpp")

    def check_health(self) -> bool:
        try:
            response = requests.get(self.server_url + "/health", timeout=5)
            if response.status_code == 200:
                return True
            elif response.status_code == 503:
                return False
            else:
                logger.warning("Unexpected health status: %s", response.status_code)
                return False
        except requests.exceptions.ConnectionError:
            logger.error("Server is down (connection refused).")
            return False

    def get_response(self, prompt: str, tools: dict = None, **kwargs) -> str:
        payload = {
            "prompt": prompt,
            "n_predict": kwargs.get("max_tokens", 2048),
            "stream": False,
        }
        if tools is not None:
            payload["tools"] = tools
        try:
            response = requests.post(
                f"{self.server_url}/completion",
                json=payload,
                timeout=60,
            )
            response.raise_for_status()
            return response.json().get("content", "")
        except requests.exceptions.RequestException as e:
            logger.error("Generation failed: %s", e)
            return ""

    @staticmethod
    def _extract_content(msg: dict) -> str:
        """Extract visible content from a message, handling thinking mode."""
        content = msg.get("content")
        reasoning = msg.get("reasoning_content")

        def _clean(text: str) -> str:
            text = re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL)
            text = re.sub(r"<tool_call>.*?</tool_call>\s*", "", text, flags=re.DOTALL)
            return text.strip()

        if content:
            cleaned = _clean(content)
            return cleaned if cleaned else content

        if reasoning:
            cleaned = _clean(reasoning)
            return cleaned if cleaned else reasoning

        return ""

    def chat(self, messages: list[dict], tools: list = None, tool_map: dict = None, **kwargs) -> str:
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        payload = {
            "model": kwargs.get("model", "local-model"),
            "messages": messages,
            "max_tokens": kwargs.get("max_tokens", 2048),
            "temperature": kwargs.get("temperature", 0.7),
        }
        if tools is not None:
            payload["tools"] = tools
        if "response_format" in kwargs:
            payload["response_format"] = kwargs["response_format"]
        try:
            response = requests.post(
                f"{self.server_url}/v1/chat/completions",
                json=payload,
                timeout=120,
            )
            if not response.ok:
                raise RuntimeError(
                    f"llama.cpp returned {response.status_code}:\n{response.text}\n\nPayload sent:\n{json.dumps(payload, indent=2)}"
                )
            result = response.json()
            msg = result["choices"][0]["message"]

            if not msg.get("tool_calls"):
                return self._extract_content(msg)

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
                        "tool_call_id": tool_call["id"],
                        "content": str(tool_result),
                    })

                payload["messages"] = messages
                if i >= self.strip_tools_after - 1:
                    payload.pop("tools", None)
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
            logger.error("Chat failed: %s", e)
            return ""
