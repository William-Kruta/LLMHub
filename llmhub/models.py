"""Pydantic models for LLM Hub server configurations."""

import uuid
import shlex
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


CURRENT_SCHEMA_VERSION = 3


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
    n_predict: int = Field(default=-1, ge=-1, description="Maximum output tokens (-1 = unlimited)")
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
    n_predict: int = Field(default=-1, ge=-1)
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
    n_predict: int | None = Field(default=None, ge=-1)
    threads: int | None = Field(default=None, ge=1)
    parallel: int | None = Field(default=None, ge=1)
    cont_batching: bool | None = None
    extra_args: str | None = None
    advanced_args: list[str] | None = None
    env_vars: dict[str, str] | None = None
    preset: str | None = None
    mmproj_path: str | None = None

    @field_validator("*", mode="before")
    @classmethod
    def reject_explicit_null(cls, value):
        if value is None:
            raise ValueError("Config fields cannot be null; omit fields to leave them unchanged")
        return value

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


class LlamaBenchRequest(BaseModel):
    """A matrix of local llama-bench performance tests."""

    config_id: str = Field(..., min_length=1)
    binary_path: str = ""
    prompt_tokens: list[int] = Field(default_factory=lambda: [128, 512, 2048])
    generation_tokens: list[int] = Field(default_factory=lambda: [64, 128, 256])
    threads: list[int] = Field(default_factory=lambda: [4])
    gpu_layers: list[int] = Field(default_factory=lambda: [-1])
    batch_sizes: list[int] = Field(default_factory=lambda: [2048])
    ubatch_sizes: list[int] = Field(default_factory=lambda: [512])
    flash_attention: list[Literal["auto", "on", "off"]] = Field(default_factory=lambda: ["auto"])
    repetitions: int = Field(default=5, ge=1, le=20)
    no_warmup: bool = False
    extra_args: str = ""

    @field_validator("prompt_tokens", "generation_tokens")
    @classmethod
    def validate_token_counts(cls, value: list[int]) -> list[int]:
        if any(item <= 0 for item in value):
            raise ValueError("Token counts must be positive integers")
        return list(dict.fromkeys(value))

    @field_validator("threads", "batch_sizes", "ubatch_sizes")
    @classmethod
    def validate_positive_matrix(cls, value: list[int]) -> list[int]:
        if not value or any(item <= 0 for item in value):
            raise ValueError("Benchmark matrix values must be positive integers")
        return list(dict.fromkeys(value))

    @field_validator("gpu_layers")
    @classmethod
    def validate_gpu_layers(cls, value: list[int]) -> list[int]:
        if not value or any(item < -1 for item in value):
            raise ValueError("GPU layer values must be -1 or greater")
        return list(dict.fromkeys(value))

    @field_validator("flash_attention")
    @classmethod
    def validate_flash_attention(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("At least one flash attention mode is required")
        return list(dict.fromkeys(value))

    @field_validator("extra_args")
    @classmethod
    def validate_benchmark_extra_args(cls, value: str) -> str:
        try:
            args = shlex.split(value) if value.strip() else []
        except ValueError as exc:
            raise ValueError(f"Extra arguments are not valid shell-style syntax: {exc}") from exc
        controlled = {"-m", "--model", "-o", "--output", "-oe", "--output-err"}
        if any(arg in controlled for arg in args):
            raise ValueError("Model and output flags are managed by LLM Hub")
        return value

    @model_validator(mode="after")
    def validate_matrix_size(self):
        if not self.prompt_tokens and not self.generation_tokens:
            raise ValueError("Select at least one prompt or generation token count")
        base_tests = len(self.prompt_tokens) + len(self.generation_tokens)
        combinations = (
            base_tests
            * len(self.threads)
            * len(self.gpu_layers)
            * len(self.batch_sizes)
            * len(self.ubatch_sizes)
            * len(self.flash_attention)
        )
        if combinations > 256:
            raise ValueError(f"Benchmark matrix has {combinations} tests; the maximum is 256")
        return self


class LlamaBenchRun(BaseModel):
    """Runtime and persisted result data for one llama-bench invocation."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: Literal["running", "stopping", "completed", "failed", "cancelled"] = "running"
    config_id: str
    config_name: str
    model_path: str
    params: LlamaBenchRequest
    command: list[str] = Field(default_factory=list)
    command_text: str = ""
    started_at: str
    finished_at: str | None = None
    duration_seconds: float | None = None
    exit_code: int | None = None
    error: str | None = None
    log_lines: list[str] = Field(default_factory=list)
    results: list[dict] = Field(default_factory=list)


class LlamaBenchOverview(BaseModel):
    """Availability, active work, and recent llama-bench history."""

    available: bool
    binary_path: str | None = None
    active: LlamaBenchRun | None = None
    history: list[LlamaBenchRun] = Field(default_factory=list)


class LogAnnotation(BaseModel):
    """Readable hint for a detected log pattern."""

    severity: str
    title: str
    detail: str
    matched_text: str | None = None
