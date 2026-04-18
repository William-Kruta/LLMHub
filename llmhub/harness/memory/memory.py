from typing import List, Dict


class Memory:
    """
    Manages a windowed conversation history.

    History is stored as a list of {"role": ..., "content": ...} dicts,
    which maps directly to what all providers expect in their chat() call.

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
        """
        Trim messages to stay within max_turns pairs.
        System messages are left untouched; only the oldest
        user/assistant messages are removed.
        """
        # Count non-system messages
        non_system = [m for m in self._messages if m["role"] != "system"]
        max_messages = self.max_turns * 2  # each turn = 1 user + 1 assistant

        if len(non_system) > max_messages:
            overflow = len(non_system) - max_messages
            # Remove oldest non-system messages
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
