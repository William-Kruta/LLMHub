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


def test_start_run_returns_run_id(monkeypatch):
    import llmhub.task_runner as tr
    monkeypatch.setattr(tr, "RESULTS_FILE", Path("/tmp/nonexistent_results.json"))

    # Patch threading.Thread so we don't actually start a background thread
    started = []

    class FakeThread:
        def __init__(self, target, daemon, kwargs=None):
            self._target = target
            self.daemon = daemon

        def start(self):
            started.append(True)

    monkeypatch.setattr(tr.threading, "Thread", FakeThread)

    run_id = tr.start_run(
        instructions="# Task\nDo research",
        filename="task.md",
        agent_id="agent-1",
        config_id="config-1",
        server_url="http://127.0.0.1",
        port=8080,
        tool_names=[],
        soul_md_path=None,
    )

    assert len(run_id) > 0
    assert run_id in tr._runs
    assert tr._runs[run_id]["status"] == "running"
    assert started == [True]


def test_get_run_returns_none_for_unknown():
    import llmhub.task_runner as tr
    assert tr.get_run("nonexistent-id") is None


def test_get_run_returns_state_for_known(monkeypatch):
    import llmhub.task_runner as tr
    monkeypatch.setattr(tr, "RESULTS_FILE", Path("/tmp/nonexistent_results.json"))

    class FakeThread:
        def __init__(self, target, daemon, kwargs=None):
            pass
        def start(self):
            pass

    monkeypatch.setattr(tr.threading, "Thread", FakeThread)

    run_id = tr.start_run(
        instructions="# Do this",
        filename="test.md",
        agent_id="a1",
        config_id="c1",
        server_url="http://127.0.0.1",
        port=8080,
        tool_names=[],
        soul_md_path=None,
    )
    state = tr.get_run(run_id)
    assert state is not None
    assert state["status"] == "running"


def test_stream_run_unknown_id():
    import llmhub.task_runner as tr
    events = list(tr.stream_run("no-such-id"))
    assert len(events) == 1
    parsed = json.loads(events[0].removeprefix("data: ").strip())
    assert parsed["type"] == "error"


def test_stream_run_delivers_events(monkeypatch):
    import llmhub.task_runner as tr

    run_id = str(uuid.uuid4())
    q = queue.Queue()
    tr._runs[run_id] = {"status": "complete", "queue": q, "result": None}

    q.put({"type": "phase", "text": "Searching..."})
    q.put({"type": "complete", "report": "# Done"})

    events = list(tr.stream_run(run_id))
    assert len(events) == 2
    first = json.loads(events[0].removeprefix("data: ").strip())
    assert first == {"type": "phase", "text": "Searching..."}
    second = json.loads(events[1].removeprefix("data: ").strip())
    assert second == {"type": "complete", "report": "# Done"}


def test_load_history_empty(tmp_path, monkeypatch):
    import llmhub.task_runner as tr
    monkeypatch.setattr(tr, "RESULTS_FILE", tmp_path / "results.json")
    assert tr.load_history() == []


def test_save_and_load_history(tmp_path, monkeypatch):
    import llmhub.task_runner as tr
    monkeypatch.setattr(tr, "RESULTS_FILE", tmp_path / "results.json")

    r1 = TaskResult(
        agent_id="a1", config_id="c1", filename="f1.md",
        started_at="2026-03-31T10:00:00", completed_at="2026-03-31T10:01:00",
        status="complete", report="# R1"
    )
    r2 = TaskResult(
        agent_id="a1", config_id="c1", filename="f2.md",
        started_at="2026-03-31T11:00:00", completed_at="2026-03-31T11:02:00",
        status="complete", report="# R2"
    )
    tr._save_result(r1)
    tr._save_result(r2)

    history = tr.load_history()
    assert len(history) == 2
    # newest first (reversed)
    assert history[0].filename == "f2.md"
    assert history[1].filename == "f1.md"
