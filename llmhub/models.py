"""Pydantic models for LLM Hub server configurations."""

import uuid
import shlex
from pathlib import Path

from pydantic import BaseModel, Field, field_validator


CURRENT_SCHEMA_VERSION = 2


def _validate_common(values: dict) -> dict:
    model_path = values.get("model_path")
    if model_path is not None:
        if not str(model_path).strip():
            raise ValueError("Model path is required")
        if Path(str(model_path)).suffix.lower() != ".gguf":
            raise ValueError("Model path must point to a .gguf file")

    mmproj_path = values.get("mmproj_path")
    if mmproj_path is not None and str(mmproj_path).strip():
        if Path(str(mmproj_path)).suffix.lower() not in {".mmproj", ".gguf"}:
            raise ValueError("MMProj path must point to a .mmproj or .gguf file")

    extra_args = values.get("extra_args")
    if extra_args is not None and str(extra_args).strip():
        try:
            shlex.split(str(extra_args))
        except ValueError as exc:
            raise ValueError(f"Extra arguments are not valid shell-style syntax: {exc}") from exc

    return values


class ServerConfig(BaseModel):
    """A single llama.cpp server configuration."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    schema_version: int = CURRENT_SCHEMA_VERSION
    name: str = Field(..., description="Human-readable server name")
    model_path: str = Field(..., description="Path to the .gguf model file")
    host: str = Field(default="127.0.0.1", description="Listen address")
    port: int = Field(default=8080, ge=1, le=65535, description="Listen port")
    n_gpu_layers: int = Field(default=-1, ge=-1, description="GPU layers to offload (-1 = all)")
    ctx_size: int = Field(default=4096, ge=128, description="Context window size")
    threads: int = Field(default=4, ge=1, description="CPU threads for generation")
    parallel: int = Field(default=1, ge=1, description="Concurrent request slots")
    cont_batching: bool = Field(default=True, description="Enable continuous batching")
    extra_args: str = Field(default="", description="Additional CLI flags (freeform)")
    advanced_args: list[str] = Field(default_factory=list, description="Structured additional CLI arguments")
    env_vars: dict[str, str] = Field(default_factory=dict, description="Environment variables for llama-server")
    preset: str = Field(default="custom", description="Configuration preset identifier")
    mmproj_path: str = Field(default="", description="Path to a multimodal projector (.mmproj) file")
    created_at: str | None = None
    updated_at: str | None = None
    last_started_at: str | None = None
    last_used_at: str | None = None


class ServerConfigCreate(BaseModel):
    """Payload for creating a new config (no id required)."""

    name: str
    model_path: str
    host: str = "127.0.0.1"
    port: int = Field(default=8080, ge=1, le=65535)
    n_gpu_layers: int = Field(default=-1, ge=-1)
    ctx_size: int = Field(default=4096, ge=128)
    threads: int = Field(default=4, ge=1)
    parallel: int = Field(default=1, ge=1)
    cont_batching: bool = True
    extra_args: str = ""
    advanced_args: list[str] = Field(default_factory=list)
    env_vars: dict[str, str] = Field(default_factory=dict)
    preset: str = "custom"
    mmproj_path: str = ""

    @field_validator("model_path")
    @classmethod
    def validate_model_path(cls, value: str) -> str:
        return _validate_common({"model_path": value})["model_path"]

    @field_validator("mmproj_path")
    @classmethod
    def validate_mmproj_path(cls, value: str) -> str:
        return _validate_common({"mmproj_path": value})["mmproj_path"]

    @field_validator("extra_args")
    @classmethod
    def validate_extra_args(cls, value: str) -> str:
        return _validate_common({"extra_args": value})["extra_args"]

    @field_validator("advanced_args")
    @classmethod
    def validate_advanced_args(cls, value: list[str]) -> list[str]:
        for arg in value:
            if not isinstance(arg, str) or not arg.strip():
                raise ValueError("Advanced args must be non-empty strings")
        return value

    @field_validator("env_vars")
    @classmethod
    def validate_env_vars(cls, value: dict[str, str]) -> dict[str, str]:
        for key, env_value in value.items():
            if not key or not key.replace("_", "").isalnum() or key[0].isdigit():
                raise ValueError(f"Invalid environment variable name: {key}")
            if not isinstance(env_value, str):
                raise ValueError("Environment variable values must be strings")
        return value


class ServerConfigUpdate(BaseModel):
    """Payload for updating an existing config (all fields optional)."""

    name: str | None = None
    model_path: str | None = None
    host: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    n_gpu_layers: int | None = Field(default=None, ge=-1)
    ctx_size: int | None = Field(default=None, ge=128)
    threads: int | None = Field(default=None, ge=1)
    parallel: int | None = Field(default=None, ge=1)
    cont_batching: bool | None = None
    extra_args: str | None = None
    advanced_args: list[str] | None = None
    env_vars: dict[str, str] | None = None
    preset: str | None = None
    mmproj_path: str | None = None

    @field_validator("model_path")
    @classmethod
    def validate_model_path(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_common({"model_path": value})["model_path"]

    @field_validator("mmproj_path")
    @classmethod
    def validate_mmproj_path(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_common({"mmproj_path": value})["mmproj_path"]

    @field_validator("extra_args")
    @classmethod
    def validate_extra_args(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_common({"extra_args": value})["extra_args"]

    @field_validator("advanced_args")
    @classmethod
    def validate_advanced_args(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        return ServerConfigCreate.validate_advanced_args(value)

    @field_validator("env_vars")
    @classmethod
    def validate_env_vars(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return value
        return ServerConfigCreate.validate_env_vars(value)


class TokenUsage(BaseModel):
    """Aggregated token usage for one server configuration."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    request_count: int = 0
    last_used_at: str | None = None


class ServerStatus(BaseModel):
    """Runtime status of a server."""

    config: ServerConfig
    running: bool = False
    pid: int | None = None
    error: str | None = None
    health: str = "stopped"
    status_detail: str | None = None
    command: list[str] = Field(default_factory=list)
    command_text: str = ""
    recent_output: list[str] = Field(default_factory=list)
    starting_at: str | None = None
    ready_at: str | None = None
    startup_elapsed_seconds: float | None = None
    stopped_at: str | None = None
    last_exit_code: int | None = None
    failure_summary: str | None = None
    model_size_bytes: int | None = None
    model_size_label: str | None = None
    validation_warnings: list[str] = Field(default_factory=list)
    resource_hints: list[str] = Field(default_factory=list)
    token_usage: TokenUsage = Field(default_factory=TokenUsage)


class ConfigImportPayload(BaseModel):
    """Payload for importing saved server configurations."""

    configs: list[ServerConfig | ServerConfigCreate]
    replace: bool = False


class ModelScanResult(BaseModel):
    """A discovered model or multimodal projector file."""

    path: str
    name: str
    size_bytes: int
    size_label: str
    kind: str


class GPUStatus(BaseModel):
    """Telemetry for one detected GPU."""

    index: int
    name: str
    vendor: str
    uuid: str | None = None
    vram_total_mb: int | None = None
    vram_used_mb: int | None = None
    gpu_util_percent: int | None = None
    temperature_c: int | None = None
    power_draw_w: float | None = None
    power_limit_w: float | None = None


class RAMStatus(BaseModel):
    """System memory telemetry."""

    total_mb: int
    used_mb: int
    available_mb: int | None = None
    percent_used: int
    swap_total_mb: int | None = None
    swap_used_mb: int | None = None


class PortSuggestion(BaseModel):
    """A free port suggestion."""

    host: str
    port: int


class EndpointTestResult(BaseModel):
    """Result of testing an OpenAI-compatible llama.cpp endpoint."""

    ok: bool
    status_code: int | None = None
    detail: str
    models: list[str] = Field(default_factory=list)


class Preset(BaseModel):
    """Reusable configuration preset."""

    id: str
    name: str
    description: str
    values: dict


class AppSettings(BaseModel):
    """User preferences and defaults for server configuration workflows."""

    default_host: str = "127.0.0.1"
    default_base_port: int = Field(default=8080, ge=1, le=65535)
    default_threads: int = Field(default=4, ge=1)
    default_ctx_size: int = Field(default=4096, ge=128)
    default_n_gpu_layers: int = Field(default=-1, ge=-1)
    default_parallel: int = Field(default=1, ge=1)
    default_preset: str = "custom"
    model_scan_directory: str = ""
    refresh_interval_ms: int = Field(default=3000, ge=1000)
    terminal_retention_lines: int = Field(default=2000, ge=100)


class BenchmarkResult(BaseModel):
    """Lightweight endpoint benchmark result."""

    ok: bool
    detail: str
    latency_ms: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    tokens_per_second: float | None = None


class LogAnnotation(BaseModel):
    """Readable hint for a detected log pattern."""

    severity: str
    title: str
    detail: str
    matched_text: str | None = None
