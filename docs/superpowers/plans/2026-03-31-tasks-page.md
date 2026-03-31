# Tasks Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tasks page where users upload a markdown file, select a server + agent, run `agent.research()` with SSE phase streaming, and view/save the rendered report as history.

**Architecture:** A `task_runner.py` module manages run lifecycle via a background thread that feeds phase events into a `queue.Queue` (via a custom logging handler on kharness's logger), allowing `GET /api/tasks/{run_id}/stream` to yield SSE events until complete. Completed runs are persisted to `task_results.json`. The frontend uses a two-panel layout with an `EventSource` for live phase indicators that transitions to a rendered markdown report on completion.

**Tech Stack:** FastAPI `StreamingResponse`, Python `threading` + `queue.Queue` + `logging.Handler`, kharness `agent.research()`, marked.js (CDN), vanilla JS `EventSource`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `llmhub/models.py` | Modify | Add `TaskResult` model |
| `llmhub/task_runner.py` | Create | Run lifecycle, phase queue, persistence |
| `llmhub/server.py` | Modify | Add 3 task routes |
| `ui/index.html` | Modify | Add Tasks nav item + marked.js CDN |
| `ui/app.js` | Modify | Add `// ── Tasks Page` section |
| `tests/test_task_runner.py` | Create | Unit tests for task_runner |
| `tests/test_task_routes.py` | Create | Integration tests for task routes |

---

### Task 1: Add `TaskResult` model to `llmhub/models.py`

**Files:**
- Modify: `llmhub/models.py`
- Test: `tests/test_task_runner.py` (written here, used later)

- [ ] **Step 1: Write the failing import test**

Create `tests/test_task_runner.py`:

```python
"""Unit tests for task_runner module."""
import json
import queue
import threading
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
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /mnt/machine_learning/Coding/python/WebInterface/LLMHub
python -m pytest tests/test_task_runner.py::test_task_result_defaults -v
```

Expected: FAIL with `ImportError` or `ValidationError`

- [ ] **Step 3: Add `TaskResult` to `llmhub/models.py`**

Append after the `AgentConfigUpdate` class (at the end of the file):

```python
class TaskResult(BaseModel):
    """Result of a completed research task run."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str
    config_id: str
    filename: str
    started_at: str  # ISO 8601
    completed_at: str | None = None
    status: str  # "complete" | "error"
    report: str | None = None
    error: str | None = None
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m pytest tests/test_task_runner.py::test_task_result_defaults -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add llmhub/models.py tests/test_task_runner.py
git commit -m "feat: add TaskResult model"
```

---

### Task 2: Create `llmhub/task_runner.py` — run lifecycle

**Files:**
- Create: `llmhub/task_runner.py`
- Test: `tests/test_task_runner.py`

- [ ] **Step 1: Write failing tests for `start_run` and `get_run`**

Append to `tests/test_task_runner.py`:

```python
def test_start_run_returns_run_id(monkeypatch):
    import llmhub.task_runner as tr
    monkeypatch.setattr(tr, "RESULTS_FILE", Path("/tmp/nonexistent_results.json"))

    # Patch threading.Thread so we don't actually start a background thread
    started = []

    class FakeThread:
        def __init__(self, target, daemon):
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
        def __init__(self, target, daemon):
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
python -m pytest tests/test_task_runner.py::test_start_run_returns_run_id tests/test_task_runner.py::test_get_run_returns_none_for_unknown tests/test_task_runner.py::test_get_run_returns_state_for_known -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'llmhub.task_runner'`

- [ ] **Step 3: Create `llmhub/task_runner.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_task_runner.py::test_start_run_returns_run_id tests/test_task_runner.py::test_get_run_returns_none_for_unknown tests/test_task_runner.py::test_get_run_returns_state_for_known -v
```

Expected: all 3 PASS

- [ ] **Step 5: Commit**

```bash
git add llmhub/task_runner.py tests/test_task_runner.py
git commit -m "feat: add task_runner with run lifecycle and phase queue"
```

---

### Task 3: Test and validate `_run_task` phase capture and persistence

**Files:**
- Modify: `tests/test_task_runner.py`

- [ ] **Step 1: Write tests for `stream_run` and `load_history`**

Append to `tests/test_task_runner.py`:

```python
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
```

Also add missing imports at the top of `tests/test_task_runner.py`:

```python
import json
import queue
import uuid
```

(These were already listed at the top in Task 1 — verify they are present.)

- [ ] **Step 2: Run tests**

```bash
python -m pytest tests/test_task_runner.py -v
```

Expected: all 8 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_task_runner.py
git commit -m "test: add stream_run and history tests for task_runner"
```

---

### Task 4: Add 3 task routes to `llmhub/server.py`

**Files:**
- Modify: `llmhub/server.py`
- Test: `tests/test_task_routes.py` (written here)

- [ ] **Step 1: Write failing route tests**

Create `tests/test_task_routes.py`:

```python
"""Integration tests for /api/tasks routes."""

import json
import queue
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from llmhub.server import app
import llmhub.agent_manager as am
import llmhub.config_manager as cm
import llmhub.task_runner as tr


@pytest.fixture(autouse=True)
def isolated_files(tmp_path, monkeypatch):
    monkeypatch.setattr(am, "AGENT_FILE", tmp_path / "agents.json")
    monkeypatch.setattr(cm, "CONFIG_FILE", tmp_path / "configs.json")
    monkeypatch.setattr(tr, "RESULTS_FILE", tmp_path / "results.json")
    # Clear in-memory run state between tests
    tr._runs.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def running_server(client):
    """Creates a config and fakes it as running."""
    config = client.post("/api/configs", json={
        "name": "Test Server",
        "model_path": "/tmp/model.gguf",
        "host": "127.0.0.1",
        "port": 8080,
    }).json()
    config_id = config["config"]["id"]
    with patch("llmhub.server.process_manager.is_running", return_value=True):
        yield config_id


@pytest.fixture
def agent_id(client):
    agent = client.post("/api/agents", json={"name": "Researcher", "tools": []}).json()
    return agent["id"]


def test_run_task_returns_run_id(client, running_server, agent_id, monkeypatch):
    monkeypatch.setattr(tr, "start_run", lambda **kwargs: "fake-run-id")
    res = client.post("/api/tasks/run", data={
        "agent_id": agent_id,
        "config_id": running_server,
    }, files={"file": ("task.md", b"# Do research", "text/markdown")})
    assert res.status_code == 200
    assert res.json()["run_id"] == "fake-run-id"


def test_run_task_missing_agent(client, running_server):
    res = client.post("/api/tasks/run", data={
        "agent_id": "ghost-agent",
        "config_id": running_server,
    }, files={"file": ("task.md", b"# Research", "text/markdown")})
    assert res.status_code == 400
    assert "Agent not found" in res.json()["detail"]


def test_run_task_server_not_running(client, agent_id):
    config = client.post("/api/configs", json={
        "name": "Offline",
        "model_path": "/tmp/model.gguf",
    }).json()
    config_id = config["config"]["id"]
    res = client.post("/api/tasks/run", data={
        "agent_id": agent_id,
        "config_id": config_id,
    }, files={"file": ("task.md", b"# Research", "text/markdown")})
    assert res.status_code == 400
    assert "not running" in res.json()["detail"]


def test_stream_unknown_run_id(client):
    with client.stream("GET", "/api/tasks/unknown-run/stream") as res:
        assert res.status_code == 200
        content = res.text
    assert '"type": "error"' in content


def test_stream_delivers_events(client, monkeypatch):
    run_id = "test-stream-run"
    q = queue.Queue()
    q.put({"type": "phase", "text": "Searching..."})
    q.put({"type": "complete", "report": "# Result"})
    tr._runs[run_id] = {"status": "complete", "queue": q, "result": None}

    with client.stream("GET", f"/api/tasks/{run_id}/stream") as res:
        assert res.status_code == 200
        content = res.text

    lines = [l for l in content.strip().split("\n") if l.startswith("data:")]
    assert len(lines) == 2
    first = json.loads(lines[0].removeprefix("data: "))
    assert first == {"type": "phase", "text": "Searching..."}


def test_history_empty(client):
    res = client.get("/api/tasks/history")
    assert res.status_code == 200
    assert res.json() == []


def test_history_returns_results(client, monkeypatch):
    from llmhub.models import TaskResult
    r = TaskResult(
        agent_id="a1", config_id="c1", filename="f.md",
        started_at="2026-03-31T10:00:00", completed_at="2026-03-31T10:01:00",
        status="complete", report="# Done"
    )
    tr._save_result(r)
    res = client.get("/api/tasks/history")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["filename"] == "f.md"
```

- [ ] **Step 2: Run to confirm failure**

```bash
python -m pytest tests/test_task_routes.py -v
```

Expected: FAIL — routes don't exist yet

- [ ] **Step 3: Add routes to `llmhub/server.py`**

At the top of `server.py`, add to the import line:

```python
from fastapi import FastAPI, HTTPException, UploadFile, Form
from fastapi.responses import FileResponse, StreamingResponse
```

(Replace the existing `from fastapi import FastAPI, HTTPException` and `from fastapi.responses import FileResponse` lines.)

Also add the task_runner import after the existing `from . import chat` line:

```python
from . import task_runner
from .models import ServerConfigCreate, ServerConfigUpdate, ServerStatus, ChatRequest, AgentConfig, AgentConfigCreate, AgentConfigUpdate, TaskResult
```

Then add this section before the `# ── Static Files & SPA` section:

```python
# ── Tasks API ───────────────────────────────────────────


@app.post("/api/tasks/run")
async def run_task(
    file: UploadFile,
    agent_id: str = Form(...),
    config_id: str = Form(...),
):
    """Start a research task. Returns a run_id for SSE streaming."""
    agent_config = agent_manager.get_agent(agent_id)
    if not agent_config:
        raise HTTPException(status_code=400, detail="Agent not found")

    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=400, detail="Config not found")

    if not process_manager.is_running(config_id):
        raise HTTPException(status_code=400, detail="Server is not running")

    instructions = (await file.read()).decode("utf-8")
    filename = file.filename or "task.md"
    server_url = "http://" + config.host

    run_id = task_runner.start_run(
        instructions=instructions,
        filename=filename,
        agent_id=agent_id,
        config_id=config_id,
        server_url=server_url,
        port=config.port,
        tool_names=agent_config.tools,
        soul_md_path=agent_config.soul_md_path,
    )
    return {"run_id": run_id}


@app.get("/api/tasks/{run_id}/stream")
def stream_task(run_id: str):
    """SSE stream for a running task. Yields phase/complete/error events."""
    return StreamingResponse(
        task_runner.stream_run(run_id),
        media_type="text/event-stream",
    )


@app.get("/api/tasks/history")
def get_task_history() -> list[TaskResult]:
    """Return completed task results, newest first."""
    return task_runner.load_history()
```

**Important:** The `/api/tasks/history` route must be registered **before** `/api/tasks/{run_id}/stream` to avoid FastAPI treating `"history"` as a `run_id` path parameter. In the code above they are ordered correctly (history last in our listing but `history` route must come before `{run_id}` routes in the file). Reorder: put `get_task_history` before `stream_task` in `server.py`.

Actually the correct order to put them in `server.py` is:

1. `POST /api/tasks/run`
2. `GET /api/tasks/history`  ← must be before the path-param route
3. `GET /api/tasks/{run_id}/stream`

- [ ] **Step 4: Run tests**

```bash
python -m pytest tests/test_task_routes.py -v
```

Expected: all 7 PASS

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
python -m pytest -v
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add llmhub/server.py tests/test_task_routes.py
git commit -m "feat: add task run, stream, and history API routes"
```

---

### Task 5: Add Tasks nav item and marked.js to `ui/index.html`

**Files:**
- Modify: `ui/index.html`

- [ ] **Step 1: Add Tasks nav item**

In `ui/index.html`, insert the Tasks nav item between the Agents `</a>` and the Chat `<a>` (after line 74, before line 75):

```html
            <a href="#tasks" class="nav-item" data-page="tasks" id="nav-tasks">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                </svg>
                <span>Tasks</span>
            </a>
```

- [ ] **Step 2: Add marked.js CDN script**

In `ui/index.html`, add before `<script src="/ui/app.js"></script>`:

```html
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
```

- [ ] **Step 3: Verify HTML is well-formed**

Open `ui/index.html` and visually confirm the nav order is: Hub → Configs → Terminal → Agents → **Tasks** → Chat.

- [ ] **Step 4: Commit**

```bash
git add ui/index.html
git commit -m "feat: add Tasks nav item and marked.js CDN to index.html"
```

---

### Task 6: Add Tasks page to `ui/app.js` — render and router

**Files:**
- Modify: `ui/app.js`

- [ ] **Step 1: Add state variables**

In `ui/app.js`, after `let agents = [];` (line 10), add:

```js
let taskHistory = [];
let currentRunId = null;
```

- [ ] **Step 2: Add `fetchTaskHistory` function**

After the `fetchAgents()` function (around line 88), add:

```js
async function fetchTaskHistory() {
    try {
        taskHistory = await apiGet('/tasks/history');
    } catch (e) {
        taskHistory = [];
    }
}
```

- [ ] **Step 3: Update `render()` to handle the tasks page**

In `ui/app.js` `render()` function, add `fetchTaskHistory()` to the `Promise.all` call:

```js
await Promise.all([fetchServers(), fetchAgents(), fetchTaskHistory()]);
```

Then add the tasks branch in the `if/else` chain after the `agents` branch:

```js
    } else if (currentPage === 'tasks') {
        main.innerHTML = renderTaskPage();
        bindTaskEvents();
    } else if (currentPage === 'terminal') {
```

- [ ] **Step 4: Add `renderTaskPage()` function**

Add this new section before `// ── Modal` (around line 751):

```js
// ── Tasks Page ─────────────────────────────────────────
function renderTaskPage() {
    const serverOptions = servers.map(s =>
        `<option value="${s.config.id}">${escapeHtml(s.config.name)}${s.running ? '' : ' (stopped)'}</option>`
    ).join('');

    const agentOptions = agents.length
        ? agents.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')
        : '<option value="" disabled>No agents configured</option>';

    const historyItems = taskHistory.map(r => {
        const agentName = agents.find(a => a.id === r.agent_id)?.name || r.agent_id;
        const ago = relativeTime(r.completed_at || r.started_at);
        return `<div class="task-history-item" data-report="${escapeHtml(r.report || '')}" data-filename="${escapeHtml(r.filename)}">
            <span class="task-history-name">${escapeHtml(r.filename)}</span>
            <span class="task-history-meta">${escapeHtml(agentName)} &middot; ${ago}</span>
        </div>`;
    }).join('');

    return `
        <div class="page-header">
            <div>
                <h1>Tasks</h1>
                <p class="subtitle">Run research tasks with an agent and view results</p>
            </div>
        </div>
        <div class="task-layout">
            <div class="task-left-panel">
                <div class="form-group">
                    <label for="task-server-select">Server</label>
                    <select id="task-server-select">${servers.length ? serverOptions : '<option value="" disabled>No servers configured</option>'}</select>
                </div>
                <div class="form-group">
                    <label for="task-agent-select">Agent</label>
                    <select id="task-agent-select">${agentOptions}</select>
                </div>
                <div class="form-group">
                    <label for="task-file-input">Task File (.md)</label>
                    <input type="file" id="task-file-input" accept=".md,text/markdown">
                </div>
                <button class="btn btn-primary" id="task-run-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
                    Run Task
                </button>
                ${taskHistory.length ? `
                <div class="task-history-section">
                    <div class="task-history-label">History</div>
                    ${historyItems}
                </div>` : ''}
            </div>
            <div class="task-right-panel" id="task-right-panel">
                <div class="task-empty-state">
                    <p>Upload a markdown file and click Run Task to start.</p>
                </div>
            </div>
        </div>`;
}
```

- [ ] **Step 5: Add `relativeTime` helper**

Add before `// ── Confirm Dialog` (around line 851):

```js
function relativeTime(isoString) {
    if (!isoString) return '';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
}
```

- [ ] **Step 6: Commit**

```bash
git add ui/app.js
git commit -m "feat: add renderTaskPage and relativeTime helper"
```

---

### Task 7: Add `bindTaskEvents`, `runTask`, `renderPhaseUpdate`, `renderReport` to `ui/app.js`

**Files:**
- Modify: `ui/app.js`

- [ ] **Step 1: Add `renderPhaseUpdate` and `renderReport`**

In the `// ── Tasks Page` section, after `renderTaskPage()`, add:

```js
function renderPhaseUpdate(text) {
    const panel = document.getElementById('task-right-panel');
    if (!panel) return;
    // On first phase, clear the empty state
    if (panel.querySelector('.task-empty-state') || panel.querySelector('.task-report')) {
        panel.innerHTML = '<div class="task-phases"></div>';
    }
    const phases = panel.querySelector('.task-phases');
    if (!phases) return;
    const line = document.createElement('div');
    line.className = 'task-phase-line';
    line.textContent = text;
    phases.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
}

function renderReport(markdown) {
    const panel = document.getElementById('task-right-panel');
    if (!panel) return;
    panel.innerHTML = `<div class="task-report">${marked.parse(markdown)}</div>`;
}
```

- [ ] **Step 2: Add `runTask`**

After `renderReport`, add:

```js
async function runTask() {
    const serverSelect = document.getElementById('task-server-select');
    const agentSelect = document.getElementById('task-agent-select');
    const fileInput = document.getElementById('task-file-input');
    const runBtn = document.getElementById('task-run-btn');

    const configId = serverSelect?.value;
    const agentId = agentSelect?.value;
    const file = fileInput?.files[0];

    if (!configId) { showToast('Select a server', 'error'); return; }
    if (!agentId) { showToast('Select an agent', 'error'); return; }
    if (!file) { showToast('Choose a .md file', 'error'); return; }

    runBtn.disabled = true;
    runBtn.textContent = 'Running…';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('agent_id', agentId);
    formData.append('config_id', configId);

    let runId;
    try {
        const res = await fetch(`${API_BASE}/tasks/run`, { method: 'POST', body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(err.detail || 'Failed to start task');
        }
        const data = await res.json();
        runId = data.run_id;
    } catch (e) {
        showToast('Failed to start task: ' + e.message, 'error');
        runBtn.disabled = false;
        runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Run Task';
        return;
    }

    currentRunId = runId;

    const evtSource = new EventSource(`${API_BASE}/tasks/${runId}/stream`);

    evtSource.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.type === 'phase') {
            renderPhaseUpdate(event.text);
        } else if (event.type === 'complete') {
            evtSource.close();
            renderReport(event.report);
            runBtn.disabled = false;
            runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Run Task';
            fetchTaskHistory().then(() => {
                const histSec = document.querySelector('.task-history-section');
                if (histSec) histSec.outerHTML = renderHistorySection();
            });
        } else if (event.type === 'error') {
            evtSource.close();
            showToast('Task error: ' + event.message, 'error');
            runBtn.disabled = false;
            runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Run Task';
        }
    };

    evtSource.onerror = () => {
        evtSource.close();
        showToast('Connection to task stream lost', 'error');
        runBtn.disabled = false;
        runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Run Task';
    };
}
```

- [ ] **Step 3: Add `renderHistorySection` helper**

After `runTask`, add:

```js
function renderHistorySection() {
    if (!taskHistory.length) return '';
    const items = taskHistory.map(r => {
        const agentName = agents.find(a => a.id === r.agent_id)?.name || r.agent_id;
        const ago = relativeTime(r.completed_at || r.started_at);
        return `<div class="task-history-item" data-report="${escapeHtml(r.report || '')}" data-filename="${escapeHtml(r.filename)}">
            <span class="task-history-name">${escapeHtml(r.filename)}</span>
            <span class="task-history-meta">${escapeHtml(agentName)} &middot; ${ago}</span>
        </div>`;
    }).join('');
    return `<div class="task-history-section">
        <div class="task-history-label">History</div>
        ${items}
    </div>`;
}
```

- [ ] **Step 4: Add `bindTaskEvents`**

After `renderHistorySection`, add:

```js
function bindTaskEvents() {
    document.getElementById('task-run-btn')?.addEventListener('click', runTask);

    document.querySelectorAll('.task-history-item').forEach(el => {
        el.addEventListener('click', () => {
            const report = el.dataset.report;
            if (report) renderReport(report);
        });
    });
}
```

- [ ] **Step 5: Verify the page loads without console errors**

Start the server (`python main.py`) and navigate to `#tasks` in the browser. Confirm the two-panel layout renders with dropdowns populated and no JS errors.

- [ ] **Step 6: Commit**

```bash
git add ui/app.js
git commit -m "feat: add bindTaskEvents, runTask, renderPhaseUpdate, renderReport"
```

---

### Task 8: Add CSS styles for the Tasks page to `ui/styles.css`

**Files:**
- Modify: `ui/styles.css`

- [ ] **Step 1: Add task layout styles**

Append to `ui/styles.css`:

```css
/* ── Tasks Page ──────────────────────────────────────── */
.task-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 1.5rem;
    height: calc(100vh - 140px);
}

.task-left-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    overflow-y: auto;
}

.task-left-panel .btn {
    width: 100%;
    justify-content: center;
}

.task-right-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    overflow-y: auto;
}

.task-empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 0.9rem;
}

.task-phases {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.task-phase-line {
    padding: 0.4rem 0.75rem;
    background: var(--surface-2, rgba(255,255,255,0.04));
    border-left: 3px solid var(--accent);
    border-radius: 4px;
    font-size: 0.85rem;
    color: var(--text-secondary);
    font-family: monospace;
}

.task-report {
    line-height: 1.7;
}

.task-report h1, .task-report h2, .task-report h3 {
    margin-top: 1.5rem;
    margin-bottom: 0.5rem;
}

.task-report p {
    margin-bottom: 1rem;
}

.task-report code {
    background: var(--surface-2, rgba(255,255,255,0.08));
    padding: 0.1em 0.4em;
    border-radius: 3px;
    font-size: 0.9em;
}

.task-report pre {
    background: var(--surface-2, rgba(255,255,255,0.08));
    padding: 1rem;
    border-radius: 8px;
    overflow-x: auto;
    margin-bottom: 1rem;
}

.task-history-section {
    margin-top: 1rem;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
}

.task-history-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
}

.task-history-item {
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
    margin-bottom: 0.25rem;
}

.task-history-item:hover {
    background: var(--surface-hover, rgba(255,255,255,0.06));
}

.task-history-name {
    font-size: 0.85rem;
    font-weight: 500;
}

.task-history-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
}
```

- [ ] **Step 2: Verify styling in browser**

Navigate to `#tasks`. Confirm left panel has proper form layout, right panel has bordered card style, history items are readable.

- [ ] **Step 3: Commit**

```bash
git add ui/styles.css
git commit -m "feat: add CSS styles for Tasks page layout"
```

---

### Task 9: Run full test suite and smoke test

**Files:** None modified — verification only

- [ ] **Step 1: Run all tests**

```bash
cd /mnt/machine_learning/Coding/python/WebInterface/LLMHub
python -m pytest -v
```

Expected: all tests pass (16 existing + 8 task_runner + 7 task_routes = 31 total)

- [ ] **Step 2: Manual smoke test checklist**

Start the app: `python main.py`

1. Navigate to `#tasks` — two-panel layout renders, no JS errors
2. No servers/agents → dropdowns show disabled "no X configured" option
3. Create a config at `#configs`, start the server
4. Create an agent at `#agents`
5. Return to `#tasks` — server and agent dropdowns are populated
6. Upload a `.md` file, click Run Task
7. Right panel shows phase indicator lines as they arrive
8. On completion, right panel renders markdown report
9. History section appears in left panel with filename and time
10. Clicking a history item re-renders the report in the right panel

- [ ] **Step 3: Commit if any fixes were needed**

```bash
git add -p
git commit -m "fix: <description of any fixes found during smoke test>"
```

---

### Task 10: Final commit and cleanup

- [ ] **Step 1: Verify git log looks clean**

```bash
git log --oneline -10
```

- [ ] **Step 2: Confirm all files are tracked**

```bash
git status
```

Expected: clean working tree (no untracked files relevant to this feature)

- [ ] **Step 3: Done**

The Tasks page is complete. Users can upload a `.md` instructions file, select a server and agent, and watch `agent.research()` run with live phase streaming via SSE. Completed reports are rendered with marked.js and auto-saved to history.
