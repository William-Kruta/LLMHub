"""Pydantic models for LLM Hub server configurations."""

import uuid
from pydantic import BaseModel, Field


class ServerConfig(BaseModel):
    """A single llama.cpp server configuration."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str = Field(..., description="Human-readable server name")
    model_path: str = Field(..., description="Path to the .gguf model file")
    host: str = Field(default="127.0.0.1", description="Listen address")
    port: int = Field(default=8080, description="Listen port")
    n_gpu_layers: int = Field(default=-1, description="GPU layers to offload (-1 = all)")
    ctx_size: int = Field(default=4096, description="Context window size")
    threads: int = Field(default=4, description="CPU threads for generation")
    parallel: int = Field(default=1, description="Concurrent request slots")
    cont_batching: bool = Field(default=True, description="Enable continuous batching")
    extra_args: str = Field(default="", description="Additional CLI flags (freeform)")


class ServerConfigCreate(BaseModel):
    """Payload for creating a new config (no id required)."""

    name: str
    model_path: str
    host: str = "127.0.0.1"
    port: int = 8080
    n_gpu_layers: int = -1
    ctx_size: int = 4096
    threads: int = 4
    parallel: int = 1
    cont_batching: bool = True
    extra_args: str = ""


class ServerConfigUpdate(BaseModel):
    """Payload for updating an existing config (all fields optional)."""

    name: str | None = None
    model_path: str | None = None
    host: str | None = None
    port: int | None = None
    n_gpu_layers: int | None = None
    ctx_size: int | None = None
    threads: int | None = None
    parallel: int | None = None
    cont_batching: bool | None = None
    extra_args: str | None = None


class ServerStatus(BaseModel):
    """Runtime status of a server."""

    config: ServerConfig
    running: bool = False
    pid: int | None = None
    error: str | None = None


class ChatRequest(BaseModel):
    """Payload for completing a chat message."""

    message: str
    system_prompt: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048
    agent_id: str | None = None


class AgentConfig(BaseModel):
    """A named KHarness agent configuration."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str = Field(..., description="Human-readable agent name")
    tools: list[str] = Field(default_factory=list, description="Selected tool names")
    soul_md_path: str | None = Field(default=None, description="Path to soul.md on host filesystem")


class AgentConfigCreate(BaseModel):
    """Payload for creating a new agent config."""

    name: str
    tools: list[str] = []
    soul_md_path: str | None = None


class AgentConfigUpdate(BaseModel):
    """Payload for updating an existing agent config (all fields optional)."""

    name: str | None = None
    tools: list[str] | None = None
    soul_md_path: str | None = None


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
