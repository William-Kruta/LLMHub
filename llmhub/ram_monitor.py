"""Best-effort system memory telemetry."""

import os

from .models import RAMStatus


def get_ram() -> RAMStatus | None:
    """Return system RAM telemetry when available."""
    return _read_proc_meminfo() or _read_sysconf_memory()


def _read_proc_meminfo(path: str = "/proc/meminfo") -> RAMStatus | None:
    try:
        raw = open(path, encoding="utf-8").read().splitlines()
    except OSError:
        return None

    values: dict[str, int] = {}
    for line in raw:
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        parts = rest.strip().split()
        if not parts:
            continue
        try:
            values[key] = int(parts[0])
        except ValueError:
            continue

    total_kb = values.get("MemTotal")
    if not total_kb:
        return None
    available_kb = values.get("MemAvailable")
    free_kb = values.get("MemFree", 0)
    buffers_kb = values.get("Buffers", 0)
    cached_kb = values.get("Cached", 0) + values.get("SReclaimable", 0)
    used_kb = total_kb - (available_kb if available_kb is not None else free_kb + buffers_kb + cached_kb)
    swap_total_kb = values.get("SwapTotal")
    swap_free_kb = values.get("SwapFree")

    return _build_status(
        total_kb=total_kb,
        used_kb=max(0, used_kb),
        available_kb=available_kb,
        swap_total_kb=swap_total_kb,
        swap_used_kb=(swap_total_kb - swap_free_kb) if swap_total_kb is not None and swap_free_kb is not None else None,
    )


def _read_sysconf_memory() -> RAMStatus | None:
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        pages = os.sysconf("SC_PHYS_PAGES")
        available_pages = os.sysconf("SC_AVPHYS_PAGES")
    except (OSError, ValueError, AttributeError):
        return None

    total_kb = round((page_size * pages) / 1024)
    available_kb = round((page_size * available_pages) / 1024)
    return _build_status(total_kb=total_kb, used_kb=max(0, total_kb - available_kb), available_kb=available_kb)


def _build_status(
    total_kb: int,
    used_kb: int,
    available_kb: int | None = None,
    swap_total_kb: int | None = None,
    swap_used_kb: int | None = None,
) -> RAMStatus:
    total_mb = _kb_to_mb(total_kb)
    used_mb = _kb_to_mb(used_kb)
    return RAMStatus(
        total_mb=total_mb,
        used_mb=used_mb,
        available_mb=_kb_to_mb(available_kb) if available_kb is not None else None,
        percent_used=round((used_mb / total_mb) * 100) if total_mb else 0,
        swap_total_mb=_kb_to_mb(swap_total_kb) if swap_total_kb is not None else None,
        swap_used_mb=_kb_to_mb(swap_used_kb) if swap_used_kb is not None else None,
    )


def _kb_to_mb(value: int) -> int:
    return round(value / 1024)
