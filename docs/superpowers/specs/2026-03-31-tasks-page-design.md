# Tasks Page Design Spec
**Date:** 2026-03-31
**Status:** Approved

## Overview

A "Tasks" page where the user uploads a markdown file containing research instructions, selects a server and agent, and executes `agent.research()` with real-time SSE phase streaming. The completed report is rendered as markdown and auto-saved to history.

---

## Backend

### New file: `llmhub/task_runner.py`

Manages run lifecycle: background thread execution, phase event streaming via a custom `logging.Handler` feeding a `queue.Queue`, and persistence of completed results.

**Run state (in-memory):**
```python
_runs: dict[str, dict] = {}
# {
#   run_id: {
#     "status": "running" | "complete" | "error",
#     "queue": queue.Queue,   # phase/complete/error events
#     "result": TaskResult | None
#   }
# }
```

**Phase capture mechanism:**
- Custom `logging.Handler` subclass intercepts kharness log output
- Each phase log line is put onto the run's `queue.Queue` as `{"type": "phase", "text": "..."}`
- On completion: `{"type": "complete", "report": "<markdown string>"}` is enqueued
- On error: `{"type": "error", "message": "<str>"}` is enqueued

**Persistence:** Completed `TaskResult` objects appended to `llmhub/task_results.json`.

---

### New model: `TaskResult` (in `llmhub/models.py`)

```python
class TaskResult(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str
    config_id: str
    filename: str
    started_at: str   # ISO 8601
    completed_at: str | None = None
    status: str       # "complete" | "error"
    report: str | None = None
    error: str | None = None
```

---

### New API routes (in `llmhub/server.py`)

#### `POST /api/tasks/run`
- **Body:** multipart/form-data — `file` (`.md`), `agent_id` (str), `config_id` (str)
- **Validation:** agent exists, config exists and server is running
- **Action:** starts background thread, returns `{"run_id": "<uuid>"}`

#### `GET /api/tasks/{run_id}/stream`
- **Response:** `StreamingResponse` with `Content-Type: text/event-stream`
- **Events:**
  - `data: {"type": "phase", "text": "Searching the web..."}\n\n`
  - `data: {"type": "complete", "report": "# Report\n..."}\n\n`
  - `data: {"type": "error", "message": "..."}\n\n`
- Streams until complete/error event is sent, then closes

#### `GET /api/tasks/history`
- **Response:** `list[TaskResult]` — loaded from `task_results.json`, newest first

---

## Frontend

### Nav

Add "Tasks" nav item between "Agents" and "Chat" in `ui/index.html`.

Add marked.js CDN script tag:
```html
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
```

---

### Layout: two-panel

```
┌─────────────────────┬────────────────────────────────────────┐
│  LEFT PANEL         │  RIGHT PANEL                           │
│  ─────────────────  │  ──────────────────────────────────── │
│  Server             │  (idle) Empty state / history view     │
│  [dropdown]         │                                        │
│                     │  (running) Phase indicators:           │
│  Agent              │   ○ Planning...                        │
│  [dropdown]         │   ● Searching the web...               │
│                     │   ○ Synthesizing...                    │
│  Task File          │                                        │
│  [file input .md]   │  (complete) Rendered markdown report   │
│                     │                                        │
│  [Run Task btn]     │                                        │
│  ─────────────────  │                                        │
│  History            │                                        │
│  • report1.md  2m   │                                        │
│  • report2.md  1h   │                                        │
└─────────────────────┴────────────────────────────────────────┘
```

---

### JS functions (new section `// ── Tasks Page` in `ui/app.js`)

| Function | Responsibility |
|---|---|
| `renderTaskPage()` | Build two-panel HTML, populate server/agent dropdowns from `configs`/`agents` state, render history list |
| `bindTaskEvents()` | Attach submit handler to Run Task button, history click handlers |
| `runTask()` | POST multipart to `/api/tasks/run`, open `EventSource` to `/api/tasks/{run_id}/stream`, call phase/report/error handlers |
| `renderPhaseUpdate(text)` | Append a phase indicator line to the right panel |
| `renderReport(markdown)` | Replace right panel content with `marked.parse(markdown)` output |

**History items:** filename, agent name, relative timestamp; clicking loads the stored report into the right panel.

**State additions:**
```js
let taskHistory = [];  // TaskResult[]
let currentRunId = null;
```

---

## File Changes Summary

| File | Change |
|---|---|
| `llmhub/models.py` | Add `TaskResult` model |
| `llmhub/task_runner.py` | New file — run lifecycle, phase queue, persistence |
| `llmhub/server.py` | Add 3 task routes |
| `ui/index.html` | Add Tasks nav item, marked.js CDN script |
| `ui/app.js` | Add Tasks page section (~120 lines) |
| `llmhub/task_results.json` | New data file (created on first run) |

---

## Out of Scope

- Task cancellation
- Re-running a historical task
- Pagination of history
