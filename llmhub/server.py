"""FastAPI application for LLM Hub."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .models import ServerConfigCreate, ServerConfigUpdate, ServerStatus, ChatRequest, AgentConfig, AgentConfigCreate, AgentConfigUpdate
from . import config_manager
from . import agent_manager
from . import chat
from .process_manager import process_manager

UI_DIR = Path(__file__).parent.parent / "ui"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
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
    # Invalidate cached KHarness agent so it rebuilds with new config
    chat.clear_kharness_agent(agent_id)
    agent = agent_manager.update_agent(agent_id, data)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@app.delete("/api/agents/{agent_id}", status_code=204)
def delete_agent(agent_id: str):
    """Delete an agent configuration."""
    # Invalidate cached KHarness agent so it rebuilds on next use
    chat.clear_kharness_agent(agent_id)
    if not agent_manager.delete_agent(agent_id):
        raise HTTPException(status_code=404, detail="Agent not found")


# ── Static Files & SPA ──────────────────────────────────────────────────

app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")


@app.get("/")
def serve_spa():
    """Serve the main SPA page."""
    return FileResponse(UI_DIR / "index.html")
