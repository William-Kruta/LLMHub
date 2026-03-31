"""FastAPI application for LLM Hub."""

from contextlib import asynccontextmanager
from pathlib import Path

import requests as _requests

from fastapi import FastAPI, HTTPException, UploadFile, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse

from .models import ServerConfigCreate, ServerConfigUpdate, ServerStatus, ChatRequest, AgentConfig, AgentConfigCreate, AgentConfigUpdate, TaskResult
from . import config_manager
from . import agent_manager
from . import chat
from . import task_runner
from .process_manager import process_manager

UI_DIR = Path(__file__).parent.parent / "ui"


def _probe_existing_servers() -> None:
    """At startup, detect any llama.cpp servers already running at configured addresses.

    Groups configs by (host, port) to avoid redundant HTTP calls. For each address
    that responds to /health, fetches /props to read the running model path and matches
    it against configs by filename. If only one config maps to an address and /props is
    unavailable, that config is adopted without model verification.
    """
    configs = config_manager.list_configs()
    if not configs:
        return

    # Group by address so we probe each (host, port) only once
    by_address: dict[tuple[str, int], list] = {}
    for config in configs:
        by_address.setdefault((config.host, config.port), []).append(config)

    for (host, port), group in by_address.items():
        base_url = f"http://{host}:{port}"

        # Skip if any config on this address is already managed
        if any(process_manager.is_running(c.id) for c in group):
            continue

        # Health check
        try:
            resp = _requests.get(f"{base_url}/health", timeout=2)
            if resp.status_code != 200:
                continue
        except Exception:
            continue

        # Try to read the running model path from /props
        running_model_name: str | None = None
        try:
            props = _requests.get(f"{base_url}/props", timeout=2).json()
            model_path = props.get("model_path") or ""
            if model_path:
                running_model_name = Path(model_path).name
        except Exception:
            pass

        if running_model_name is not None:
            # Match by model filename
            for config in group:
                if Path(config.model_path).name == running_model_name:
                    process_manager.adopt(config.id)
                    break
        elif len(group) == 1:
            # Only one config at this address and /props unavailable — adopt it
            process_manager.adopt(group[0].id)
        # else: multiple configs, /props unavailable — cannot safely identify which one


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    _probe_existing_servers()
    yield
    # Stop all servers on shutdown
    process_manager.stop_all()


app = FastAPI(title="LLM Hub", version="0.1.0", lifespan=lifespan)


# ── API Routes ──────────────────────────────────────────────────────────


@app.get("/api/configs")
def list_configs() -> list[ServerStatus]:
    """List all configs with their runtime status."""
    configs = config_manager.list_configs()
    return [
        ServerStatus(
            config=c,
            running=process_manager.is_running(c.id),
            pid=process_manager.get_pid(c.id),
        )
        for c in configs
    ]


@app.post("/api/configs", status_code=201)
def create_config(data: ServerConfigCreate) -> ServerStatus:
    """Create a new server configuration."""
    config = config_manager.create_config(data)
    return ServerStatus(config=config, running=False)


@app.get("/api/configs/{config_id}")
def get_config(config_id: str) -> ServerStatus:
    """Get a single config with status."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return ServerStatus(
        config=config,
        running=process_manager.is_running(config_id),
        pid=process_manager.get_pid(config_id),
    )


@app.put("/api/configs/{config_id}")
def update_config(config_id: str, data: ServerConfigUpdate) -> ServerStatus:
    """Update an existing config. Must be stopped first."""
    if process_manager.is_running(config_id):
        raise HTTPException(
            status_code=409,
            detail="Cannot update a running server. Stop it first.",
        )
    config = config_manager.update_config(config_id, data)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return ServerStatus(config=config, running=False)


@app.delete("/api/configs/{config_id}", status_code=204)
def delete_config(config_id: str):
    """Delete a config. Must be stopped first."""
    if process_manager.is_running(config_id):
        raise HTTPException(
            status_code=409,
            detail="Cannot delete a running server. Stop it first.",
        )
    if not config_manager.delete_config(config_id):
        raise HTTPException(status_code=404, detail="Config not found")


@app.post("/api/configs/{config_id}/start")
def start_server(config_id: str) -> ServerStatus:
    """Start a llama-server for this config."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    try:
        server = process_manager.start(config)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return ServerStatus(config=config, running=True, pid=server.pid)


@app.post("/api/configs/{config_id}/stop")
def stop_server(config_id: str) -> ServerStatus:
    """Stop the server for this config."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    process_manager.stop(config_id)
    return ServerStatus(config=config, running=False)


# ── Terminal Output ──────────────────────────────────────────────────────


@app.get("/api/configs/{config_id}/output")
def get_output(config_id: str, offset: int = 0):
    """Get terminal output for a server process."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    lines, total = process_manager.get_output(config_id, offset)
    return {
        "lines": lines,
        "total": total,
        "offset": offset,
        "running": process_manager.is_running(config_id),
    }


# ── Chat API ────────────────────────────────────────────────────────────


@app.post("/api/configs/{config_id}/chat")
def chat_completion(config_id: str, request: ChatRequest):
    """Send a chat message to the server."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")

    if not process_manager.is_running(config_id):
        raise HTTPException(status_code=400, detail="Server is not running")

    server_url = "http://" + config.host

    if request.agent_id:
        agent_config = agent_manager.get_agent(request.agent_id)
        if not agent_config:
            raise HTTPException(status_code=400, detail="Agent not found")
        try:
            agent = chat.get_kharness_agent(
                config_id=config_id,
                agent_id=request.agent_id,
                server_url=server_url,
                port=config.port,
                tool_names=agent_config.tools,
                soul_md_path=agent_config.soul_md_path,
            )
            response_text = agent.run(request.message, max_tokens=request.max_tokens)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

        return {
            "message": response_text,
            "history": agent.get_history(),
        }

    # Plain LlamaCpp path
    memory = chat.get_memory(config_id)

    if len(memory) == 0 and request.system_prompt:
        memory.add("system", request.system_prompt)

    memory.add("user", request.message)

    try:
        client = chat.LlamaCpp(server_url=server_url, port=config.port)
        response_text = client.chat(
            messages=memory.get_history(),
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        memory.add("assistant", response_text)

    except Exception as e:
        if len(memory._messages) > 0 and memory._messages[-1]["role"] == "user":
            memory._messages.pop()
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "message": response_text,
        "history": memory.get_history(),
    }


@app.post("/api/configs/{config_id}/chat/clear")
def clear_chat(config_id: str):
    """Clear the conversation memory for a server (both plain and agent)."""
    chat.clear_memory(config_id)
    chat.clear_kharness_agents_for_server(config_id)
    return {"status": "cleared"}


# ── Agent Config API ────────────────────────────────────────────────────


@app.get("/api/agents")
def list_agents() -> list[AgentConfig]:
    """List all agent configurations."""
    return agent_manager.list_agents()


@app.post("/api/agents", status_code=201)
def create_agent(data: AgentConfigCreate) -> AgentConfig:
    """Create a new agent configuration."""
    return agent_manager.create_agent(data)


@app.get("/api/agents/{agent_id}")
def get_agent(agent_id: str) -> AgentConfig:
    """Get a single agent configuration."""
    agent = agent_manager.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@app.put("/api/agents/{agent_id}")
def update_agent(agent_id: str, data: AgentConfigUpdate) -> AgentConfig:
    """Update an existing agent configuration."""
    agent = agent_manager.update_agent(agent_id, data)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    # Invalidate cached KHarness agent after confirmed write
    chat.clear_kharness_agent(agent_id)
    return agent


@app.delete("/api/agents/{agent_id}", status_code=204)
def delete_agent(agent_id: str):
    """Delete an agent configuration."""
    # Invalidate cached KHarness agent so it rebuilds on next use
    chat.clear_kharness_agent(agent_id)
    if not agent_manager.delete_agent(agent_id):
        raise HTTPException(status_code=404, detail="Agent not found")


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


@app.get("/api/tasks/history")
def get_task_history() -> list[TaskResult]:
    """Return completed task results, newest first."""
    return task_runner.load_history()


@app.get("/api/tasks/{run_id}/stream")
def stream_task(run_id: str):
    """SSE stream for a running task. Yields phase/complete/error events."""
    return StreamingResponse(
        task_runner.stream_run(run_id),
        media_type="text/event-stream",
    )


# ── Static Files & SPA ──────────────────────────────────────────────────

app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")


@app.get("/")
def serve_spa():
    """Serve the main SPA page."""
    return FileResponse(UI_DIR / "index.html")
