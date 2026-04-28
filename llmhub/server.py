"""FastAPI application for LLM Hub."""

from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
import socket
import time

import requests as _requests

from fastapi import Body, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import ValidationError

from .models import AppSettings, BenchmarkResult, EndpointTestResult, GPUStatus, LogAnnotation, ModelScanResult, PortSuggestion, Preset, RAMStatus, ServerConfig, ServerConfigCreate, ServerConfigUpdate, ServerStatus
from . import config_manager
from . import gpu_monitor
from . import ram_monitor
from . import settings_manager
from .process_manager import process_manager

UI_DIR = Path(__file__).parent.parent / "ui"

PRESETS = [
    Preset(id="cpu", name="CPU", description="Conservative CPU-only profile", values={"n_gpu_layers": 0, "ctx_size": 4096, "threads": 8, "parallel": 1, "extra_args": ""}),
    Preset(id="cuda-full", name="CUDA full offload", description="Offload all layers to GPU when possible", values={"n_gpu_layers": -1, "ctx_size": 8192, "threads": 8, "parallel": 1, "extra_args": ""}),
    Preset(id="large-context", name="Large context", description="Higher context window for long prompts", values={"n_gpu_layers": -1, "ctx_size": 32768, "threads": 8, "parallel": 1, "extra_args": ""}),
    Preset(id="vision", name="Vision model", description="Profile for multimodal models with mmproj", values={"n_gpu_layers": -1, "ctx_size": 8192, "threads": 8, "parallel": 1, "extra_args": "--jinja"}),
    Preset(id="low-vram", name="Low VRAM", description="Reduce GPU offload and context pressure", values={"n_gpu_layers": 20, "ctx_size": 4096, "threads": 8, "parallel": 1, "extra_args": ""}),
]


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


def _health_for(config: ServerConfig, running: bool) -> tuple[str, str | None]:
    """Probe llama.cpp health for richer status labels."""
    if not running:
        return "stopped", None

    try:
        resp = _requests.get(f"http://{config.host}:{config.port}/health", timeout=0.5)
    except Exception:
        if process_manager.is_adopted(config.id):
            return "unreachable", "No response from adopted server"
        return "loading", "Waiting for server health endpoint"

    if resp.status_code == 200:
        process_manager.mark_ready(config.id)
        return "healthy", None
    if resp.status_code == 503:
        return "loading", "Server is still loading the model"
    return "unreachable", f"Health endpoint returned HTTP {resp.status_code}"


def _status_for(config: ServerConfig) -> ServerStatus:
    """Build the API status object for one config."""
    running = process_manager.is_running(config.id)
    health, detail = _health_for(config, running)
    diagnostics = process_manager.get_diagnostics(config.id)
    started_at = process_manager.get_started_at(config.id)
    ready_at = process_manager.get_ready_at(config.id)
    return ServerStatus(
        config=config,
        running=running,
        pid=process_manager.get_pid(config.id),
        health=health,
        status_detail=detail,
        command=process_manager.build_command(config, require_binary=False),
        command_text=process_manager.command_text(config),
        recent_output=process_manager.get_recent_output(config.id),
        starting_at=started_at,
        ready_at=ready_at,
        startup_elapsed_seconds=_elapsed_seconds(started_at, ready_at),
        stopped_at=diagnostics.stopped_at,
        last_exit_code=diagnostics.last_exit_code,
        failure_summary=diagnostics.failure_summary,
        model_size_bytes=_file_size(config.model_path),
        model_size_label=_file_size_label(_file_size(config.model_path)),
        validation_warnings=_validation_warnings(config),
        resource_hints=_resource_hints(config),
    )


LOG_PATTERNS = [
    ("error", "CUDA out of memory", "Reduce GPU layers, context size, or parallel slots.", ["out of memory", "cuda malloc", "cuda error"]),
    ("error", "Port bind failure", "Another process is already listening on this host/port.", ["address already in use", "failed to bind", "bind:"]),
    ("error", "Model path problem", "Check that the model path exists and points to a GGUF file.", ["no such file", "failed to open", "cannot open model"]),
    ("warning", "Missing multimodal projector", "Vision models usually need a matching .mmproj file.", ["mmproj", "projector"]),
    ("error", "Unsupported flag", "Remove or correct the referenced llama-server argument.", ["unknown argument", "invalid argument", "unrecognized option"]),
]


def _annotate_lines(lines: list[str]) -> list[LogAnnotation]:
    annotations: list[LogAnnotation] = []
    seen: set[str] = set()
    for line in lines:
        lower = line.lower()
        for severity, title, detail, patterns in LOG_PATTERNS:
            if title in seen:
                continue
            if any(pattern in lower for pattern in patterns):
                annotations.append(LogAnnotation(severity=severity, title=title, detail=detail, matched_text=line[:500]))
                seen.add(title)
    return annotations


def _elapsed_seconds(started_at: str | None, ready_at: str | None) -> float | None:
    if not started_at:
        return None
    try:
        start = datetime.fromisoformat(started_at)
        end = datetime.fromisoformat(ready_at) if ready_at else datetime.now(start.tzinfo)
        return round((end - start).total_seconds(), 1)
    except Exception:
        return None


def _file_size(path: str) -> int | None:
    try:
        file_path = Path(path)
        return file_path.stat().st_size if file_path.is_file() else None
    except OSError:
        return None


def _file_size_label(size: int | None) -> str | None:
    if size is None:
        return None
    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return None


def _validation_warnings(config: ServerConfig) -> list[str]:
    warnings: list[str] = []
    model_path = Path(config.model_path)
    if not model_path.exists():
        warnings.append("Model file does not exist")
    elif not model_path.is_file():
        warnings.append("Model path is not a file")
    if config.mmproj_path.strip():
        mmproj_path = Path(config.mmproj_path.strip())
        if not mmproj_path.exists():
            warnings.append("MMProj file does not exist")
        elif not mmproj_path.is_file():
            warnings.append("MMProj path is not a file")
    return warnings


def _resource_hints(config: ServerConfig) -> list[str]:
    hints: list[str] = []
    size = _file_size(config.model_path)
    if size:
        gib = size / (1024 ** 3)
        hints.append(f"Model size: {_file_size_label(size)}")
        if gib >= 20 and config.n_gpu_layers == -1:
            hints.append("Large model with full GPU offload may require substantial VRAM")
    if config.ctx_size >= 32768:
        hints.append("Large context windows significantly increase memory use")
    if config.parallel > 1:
        hints.append("Parallel slots increase memory requirements")
    if config.n_gpu_layers == 0:
        hints.append("CPU-only profile may be slower but avoids VRAM pressure")
    return hints


def _parse_import_payload(payload: dict | list) -> tuple[list[ServerConfig | ServerConfigCreate], bool]:
    """Accept wrapped, array, or single-config import JSON payloads."""
    replace = False

    if isinstance(payload, dict) and "configs" in payload:
        raw_configs = payload["configs"]
        replace = bool(payload.get("replace", False))
    elif isinstance(payload, list):
        raw_configs = payload
    elif isinstance(payload, dict):
        raw_configs = [payload]
    else:
        raise HTTPException(status_code=422, detail="Import payload must be a config object, config array, or {configs: [...]}")

    if not isinstance(raw_configs, list):
        raise HTTPException(status_code=422, detail="configs must be a list")

    configs: list[ServerConfig | ServerConfigCreate] = []
    try:
        for raw in raw_configs:
            if not isinstance(raw, dict):
                raise ValueError("Each imported config must be an object")
            configs.append(ServerConfig(**raw) if raw.get("id") else ServerConfigCreate(**raw))
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return configs, replace


@app.get("/api/configs")
def list_configs() -> list[ServerStatus]:
    """List all configs with their runtime status."""
    configs = sorted(
        config_manager.list_configs(),
        key=lambda c: c.last_used_at or c.updated_at or c.created_at or "",
        reverse=True,
    )
    return [_status_for(c) for c in configs]


@app.post("/api/configs", status_code=201)
def create_config(data: ServerConfigCreate) -> ServerStatus:
    """Create a new server configuration."""
    config = config_manager.create_config(data)
    return _status_for(config)


@app.get("/api/presets")
def list_presets() -> list[Preset]:
    """List built-in server configuration presets."""
    return PRESETS


@app.get("/api/gpus")
def list_gpus() -> list[GPUStatus]:
    """Return best-effort GPU telemetry."""
    return gpu_monitor.get_gpus()


@app.get("/api/ram")
def get_ram() -> RAMStatus | None:
    """Return best-effort system memory telemetry."""
    return ram_monitor.get_ram()


@app.get("/api/settings")
def get_settings() -> AppSettings:
    """Return app settings and defaults."""
    settings = settings_manager.get_settings()
    process_manager.set_output_retention(settings.terminal_retention_lines)
    return settings


@app.put("/api/settings")
def update_settings(settings: AppSettings) -> AppSettings:
    """Update app settings and defaults."""
    updated = settings_manager.update_settings(settings)
    process_manager.set_output_retention(updated.terminal_retention_lines)
    return updated


@app.get("/api/ports/free")
def find_free_port(host: str = "127.0.0.1", start: int = 8080) -> PortSuggestion:
    """Return the first free TCP port at or above start."""
    for port in range(max(1, start), 65536):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return PortSuggestion(host=host, port=port)
    raise HTTPException(status_code=409, detail="No free port found")


@app.get("/api/models/scan")
def scan_models(directory: str, limit: int = 200) -> list[ModelScanResult]:
    """Scan a directory recursively for .gguf and .mmproj files."""
    root = Path(directory).expanduser()
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=400, detail="Directory does not exist")

    results: list[ModelScanResult] = []
    for path in root.rglob("*"):
        if len(results) >= limit:
            break
        if not path.is_file() or path.suffix.lower() not in {".gguf", ".mmproj"}:
            continue
        size = path.stat().st_size
        results.append(
            ModelScanResult(
                path=str(path),
                name=path.name,
                size_bytes=size,
                size_label=_file_size_label(size) or "",
                kind="model" if path.suffix.lower() == ".gguf" else "mmproj",
            )
        )
    return sorted(results, key=lambda item: (item.kind, item.name.lower()))


@app.get("/api/configs/export")
def export_configs():
    """Export saved server configurations."""
    return {"configs": [config.model_dump() for config in config_manager.list_configs()]}


@app.post("/api/configs/import")
def import_configs(payload: dict | list = Body(...)) -> list[ServerStatus]:
    """Import saved server configurations."""
    configs, replace = _parse_import_payload(payload)
    imported = config_manager.import_configs(configs, replace=replace)
    return [_status_for(config) for config in imported]


@app.get("/api/configs/{config_id}")
def get_config(config_id: str) -> ServerStatus:
    """Get a single config with status."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return _status_for(config)


@app.get("/api/configs/{config_id}/export")
def export_config(config_id: str):
    """Export one saved server configuration."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return config.model_dump()


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
    return _status_for(config)


@app.post("/api/configs/{config_id}/duplicate", status_code=201)
def duplicate_config(config_id: str) -> ServerStatus:
    """Duplicate an existing config with a new ID."""
    config = config_manager.duplicate_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return _status_for(config)


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
    config = config_manager.mark_started(config_id) or config
    return _status_for(config)


@app.post("/api/configs/{config_id}/stop")
def stop_server(config_id: str) -> ServerStatus:
    """Stop the server for this config."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    process_manager.stop(config_id)
    return _status_for(config)


@app.post("/api/configs/{config_id}/restart")
def restart_server(config_id: str) -> ServerStatus:
    """Restart a managed server with its current configuration."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    process_manager.stop(config_id)
    try:
        process_manager.start(config)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    config = config_manager.mark_started(config_id) or config
    return _status_for(config)


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
        "annotations": [item.model_dump() for item in _annotate_lines(lines)],
    }


@app.post("/api/configs/{config_id}/output/clear")
def clear_output(config_id: str):
    """Clear retained terminal output for a config."""
    if not config_manager.get_config(config_id):
        raise HTTPException(status_code=404, detail="Config not found")
    process_manager.clear_output(config_id)
    return {"status": "cleared"}


@app.get("/api/configs/{config_id}/logs")
def download_logs(config_id: str):
    """Download retained terminal output as plain text."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    lines, _ = process_manager.get_output(config_id, 0)
    filename = f"{config.name.replace(' ', '_') or 'server'}-{config_id}.log"
    return Response(
        "\n".join(lines) + ("\n" if lines else ""),
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/configs/{config_id}/command")
def get_command(config_id: str):
    """Return the command preview for a config."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return {
        "command": process_manager.build_command(config, require_binary=False),
        "command_text": process_manager.command_text(config),
    }


@app.post("/api/configs/{config_id}/benchmark")
def benchmark_endpoint(config_id: str) -> BenchmarkResult:
    """Run a tiny benchmark request against a healthy OpenAI-compatible endpoint."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")

    payload = {
        "messages": [{"role": "user", "content": "Reply with the word ready."}],
        "max_tokens": 16,
        "temperature": 0,
    }
    started = time.perf_counter()
    try:
        resp = _requests.post(f"http://{config.host}:{config.port}/v1/chat/completions", json=payload, timeout=30)
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        if not resp.ok:
            return BenchmarkResult(ok=False, detail=resp.text[:500], latency_ms=latency_ms)
        data = resp.json()
        usage = data.get("usage") or {}
        completion_tokens = usage.get("completion_tokens")
        tokens_per_second = None
        if completion_tokens and latency_ms > 0:
            tokens_per_second = round(completion_tokens / (latency_ms / 1000), 2)
        return BenchmarkResult(
            ok=True,
            detail="Benchmark completed",
            latency_ms=latency_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=completion_tokens,
            total_tokens=usage.get("total_tokens"),
            tokens_per_second=tokens_per_second,
        )
    except Exception as exc:
        return BenchmarkResult(ok=False, detail=str(exc))


@app.post("/api/configs/{config_id}/test")
def test_endpoint(config_id: str) -> EndpointTestResult:
    """Test the OpenAI-compatible endpoint for a config."""
    config = config_manager.get_config(config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    try:
        resp = _requests.get(f"http://{config.host}:{config.port}/v1/models", timeout=3)
        if not resp.ok:
            return EndpointTestResult(ok=False, status_code=resp.status_code, detail=resp.text[:500])
        data = resp.json()
        models = [item.get("id", "") for item in data.get("data", []) if isinstance(item, dict)]
        return EndpointTestResult(ok=True, status_code=resp.status_code, detail="Endpoint responded", models=models)
    except Exception as exc:
        return EndpointTestResult(ok=False, detail=str(exc))


# ── Static Files & SPA ──────────────────────────────────────────────────

app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")


@app.get("/")
def serve_spa():
    """Serve the main SPA page."""
    return FileResponse(UI_DIR / "index.html")
