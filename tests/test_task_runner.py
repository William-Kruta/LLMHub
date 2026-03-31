"""Unit tests for task_runner module."""
import json
import queue
import threading
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from llmhub.models import TaskResult


def test_task_result_defaults():
    result = TaskResult(
        agent_id="agent-1",
        config_id="config-1",
        filename="task.md",
        started_at="2026-03-31T10:00:00",
        status="complete",
        report="# Report",
    )
    assert result.agent_id == "agent-1"
    assert result.config_id == "config-1"
    assert result.filename == "task.md"
    assert result.status == "complete"
    assert result.report == "# Report"
    assert result.completed_at is None
    assert result.error is None
    assert len(result.id) > 0
