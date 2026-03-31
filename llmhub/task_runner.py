"""Task run lifecycle management for the Tasks page."""

import json
import logging
import queue
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .models import TaskResult
from .chat import KHarnessAgent

RESULTS_FILE = Path(__file__).parent / "task_results.json"

# In-memory run state: run_id → {status, queue, result}
_runs: dict[str, dict] = {}


class _PhaseHandler(logging.Handler):
    """Captures kharness phase log lines into a queue as SSE-ready dicts."""

    def __init__(self, q: queue.Queue):
        super().__init__()
        self._queue = q

    def emit(self, record: logging.LogRecord) -> None:
        msg = self.format(record)
        self._queue.put({"type": "phase", "text": msg})


def _run_task(
    run_id: str,
    instructions: str,
    filename: str,
    agent_id: str,
    config_id: str,
    server_url: str,
    port: int,
    tool_names: list[str],
    soul_md_path: str | None,
) -> None:
    """Background worker: runs agent.research(), feeds events into the run queue."""
    q = _runs[run_id]["queue"]
    started_at = datetime.now(timezone.utc).isoformat()

    # Attach phase handler to kharness root logger
    kharness_logger = logging.getLogger("kharness")
    handler = _PhaseHandler(q)
    handler.setLevel(logging.INFO)
    kharness_logger.addHandler(handler)

    try:
        agent = KHarnessAgent(
            server_url=server_url,
            port=port,
            tool_names=tool_names,
            soul_md_path=soul_md_path,
        )
        report = agent._agent.research(instructions)

        completed_at = datetime.now(timezone.utc).isoformat()
        result = TaskResult(
            agent_id=agent_id,
            config_id=config_id,
            filename=filename,
            started_at=started_at,
            completed_at=completed_at,
            status="complete",
            report=report,
        )
        _runs[run_id]["status"] = "complete"
        _runs[run_id]["result"] = result
        _save_result(result)
        q.put({"type": "complete", "report": report})

    except Exception as exc:
        completed_at = datetime.now(timezone.utc).isoformat()
        result = TaskResult(
            agent_id=agent_id,
            config_id=config_id,
            filename=filename,
            started_at=started_at,
            completed_at=completed_at,
            status="error",
            error=str(exc),
        )
        _runs[run_id]["status"] = "error"
        _runs[run_id]["result"] = result
        _save_result(result)
        q.put({"type": "error", "message": str(exc)})

    finally:
        kharness_logger.removeHandler(handler)


def start_run(
    instructions: str,
    filename: str,
    agent_id: str,
    config_id: str,
    server_url: str,
    port: int,
    tool_names: list[str],
    soul_md_path: str | None,
) -> str:
    """Start a background research run. Returns a new run_id."""
    run_id = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    _runs[run_id] = {"status": "running", "queue": q, "result": None}

    t = threading.Thread(
        target=_run_task,
        daemon=True,
        kwargs=dict(
            run_id=run_id,
            instructions=instructions,
            filename=filename,
            agent_id=agent_id,
            config_id=config_id,
            server_url=server_url,
            port=port,
            tool_names=tool_names,
            soul_md_path=soul_md_path,
        ),
    )
    t.start()
    return run_id


def get_run(run_id: str) -> dict | None:
    """Return the run state dict, or None if not found."""
    return _runs.get(run_id)


def stream_run(run_id: str):
    """Generator that yields SSE-formatted strings until complete or error."""
    state = _runs.get(run_id)
    if state is None:
        yield f"data: {json.dumps({'type': 'error', 'message': 'Run not found'})}\n\n"
        return

    q = state["queue"]
    while True:
        event = q.get()
        yield f"data: {json.dumps(event)}\n\n"
        if event["type"] in ("complete", "error"):
            break


def load_history() -> list[TaskResult]:
    """Load all saved TaskResult objects from disk, newest first."""
    if not RESULTS_FILE.exists():
        return []
    try:
        raw = json.loads(RESULTS_FILE.read_text())
        results = [TaskResult(**item) for item in raw]
        return list(reversed(results))
    except Exception:
        return []


def _save_result(result: TaskResult) -> None:
    """Append a TaskResult to the RESULTS_FILE."""
    existing: list[dict] = []
    if RESULTS_FILE.exists():
        try:
            existing = json.loads(RESULTS_FILE.read_text())
        except Exception:
            existing = []
    existing.append(result.model_dump())
    RESULTS_FILE.write_text(json.dumps(existing, indent=2))
