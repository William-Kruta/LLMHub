"""Tests for system memory telemetry."""

from llmhub.ram_monitor import _read_proc_meminfo


def test_read_proc_meminfo(tmp_path):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(
        "\n".join(
            [
                "MemTotal:       16384000 kB",
                "MemFree:         2048000 kB",
                "MemAvailable:    8192000 kB",
                "Buffers:          512000 kB",
                "Cached:          4096000 kB",
                "SwapTotal:       2097152 kB",
                "SwapFree:        1048576 kB",
            ]
        )
    )

    status = _read_proc_meminfo(str(meminfo))

    assert status is not None
    assert status.total_mb == 16000
    assert status.used_mb == 8000
    assert status.available_mb == 8000
    assert status.percent_used == 50
    assert status.swap_total_mb == 2048
    assert status.swap_used_mb == 1024
