"""Tests for GPU telemetry parsing."""

from llmhub.gpu_monitor import _parse_nvidia_smi


def test_parse_nvidia_smi_multiple_gpus():
    output = "\n".join(
        [
            "0, NVIDIA RTX 4090, GPU-a, 24564, 12000, 88, 63, 310.50, 450.00",
            "1, NVIDIA RTX 3090, GPU-b, 24576, 2048, 12, 42, [Not Supported], 350.00",
        ]
    )

    gpus = _parse_nvidia_smi(output)

    assert len(gpus) == 2
    assert gpus[0].name == "NVIDIA RTX 4090"
    assert gpus[0].vram_total_mb == 24564
    assert gpus[0].vram_used_mb == 12000
    assert gpus[0].gpu_util_percent == 88
    assert gpus[0].temperature_c == 63
    assert gpus[0].power_draw_w == 310.5
    assert gpus[1].power_draw_w is None
