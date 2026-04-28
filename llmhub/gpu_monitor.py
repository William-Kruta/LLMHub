"""Best-effort GPU telemetry discovery."""

import json
import shutil
import subprocess
from typing import Any

from .models import GPUStatus


def get_gpus() -> list[GPUStatus]:
    """Return detected GPU telemetry from the first supported provider."""
    for provider in (_query_nvidia_smi, _query_rocm_smi):
        try:
            gpus = provider()
        except Exception:
            gpus = []
        if gpus:
            return gpus
    return []


def _query_nvidia_smi() -> list[GPUStatus]:
    if not shutil.which("nvidia-smi"):
        return []

    fields = [
        "index",
        "name",
        "uuid",
        "memory.total",
        "memory.used",
        "utilization.gpu",
        "temperature.gpu",
        "power.draw",
        "power.limit",
    ]
    result = subprocess.run(
        [
            "nvidia-smi",
            f"--query-gpu={','.join(fields)}",
            "--format=csv,noheader,nounits",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=3,
    )
    if result.returncode != 0:
        return []
    return _parse_nvidia_smi(result.stdout)


def _parse_nvidia_smi(output: str) -> list[GPUStatus]:
    gpus: list[GPUStatus] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 9:
            continue
        gpus.append(
            GPUStatus(
                index=_to_int(parts[0]) or len(gpus),
                name=parts[1] or f"NVIDIA GPU {len(gpus)}",
                vendor="NVIDIA",
                uuid=parts[2] or None,
                vram_total_mb=_to_int(parts[3]),
                vram_used_mb=_to_int(parts[4]),
                gpu_util_percent=_to_int(parts[5]),
                temperature_c=_to_int(parts[6]),
                power_draw_w=_to_float(parts[7]),
                power_limit_w=_to_float(parts[8]),
            )
        )
    return gpus


def _query_rocm_smi() -> list[GPUStatus]:
    if not shutil.which("rocm-smi"):
        return []

    result = subprocess.run(
        [
            "rocm-smi",
            "--showproductname",
            "--showuse",
            "--showmemuse",
            "--showmeminfo",
            "vram",
            "--showtemp",
            "--json",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=3,
    )
    if result.returncode != 0:
        return []
    return _parse_rocm_smi(result.stdout)


def _parse_rocm_smi(output: str) -> list[GPUStatus]:
    try:
        raw = json.loads(output)
    except json.JSONDecodeError:
        return []
    if not isinstance(raw, dict):
        return []

    gpus: list[GPUStatus] = []
    for key, value in sorted(raw.items()):
        if not isinstance(value, dict) or not key.lower().startswith("card"):
            continue
        index = _to_int(key[4:]) if len(key) > 4 else len(gpus)
        total_bytes = _find_metric(value, ("vram total", "total memory"))
        used_bytes = _find_metric(value, ("vram used", "used memory"))
        memory_use_percent = _find_metric(value, ("memory use",))
        gpus.append(
            GPUStatus(
                index=index if index is not None else len(gpus),
                name=str(_find_metric(value, ("card series", "product name", "device name")) or f"AMD GPU {len(gpus)}"),
                vendor="AMD",
                vram_total_mb=_bytes_to_mb(total_bytes),
                vram_used_mb=_bytes_to_mb(used_bytes),
                gpu_util_percent=_to_int(_find_metric(value, ("gpu use", "gpu busy"))),
                temperature_c=_to_int(_find_metric(value, ("temperature",))),
            )
        )
        if gpus[-1].vram_used_mb is None and gpus[-1].vram_total_mb and memory_use_percent is not None:
            gpus[-1].vram_used_mb = round(gpus[-1].vram_total_mb * (_to_float(memory_use_percent) or 0) / 100)
    return gpus


def _find_metric(data: dict[str, Any], patterns: tuple[str, ...]) -> Any:
    for key, value in data.items():
        lower = key.lower()
        if any(pattern in lower for pattern in patterns):
            return value
    return None


def _to_int(value: Any) -> int | None:
    number = _to_float(value)
    return round(number) if number is not None else None


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"n/a", "nan", "not supported", "[not supported]"}:
        return None
    cleaned = "".join(ch for ch in text if ch.isdigit() or ch in ".-")
    if not cleaned or cleaned in {".", "-", "-."}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _bytes_to_mb(value: Any) -> int | None:
    number = _to_float(value)
    if number is None:
        return None
    if number > 1024 * 1024:
        return round(number / (1024 * 1024))
    return round(number)
