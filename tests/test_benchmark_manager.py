"""Tests for llama-bench command construction and result retention."""

import json
import time

import pytest
from pydantic import ValidationError

import llmhub.benchmark_manager as bm
from llmhub.models import LlamaBenchRequest, ServerConfig


def _fake_benchmark(tmp_path, *, valid_json: bool = True):
    binary = tmp_path / "llama-bench"
    stdout = json.dumps(
        [
            {
                "model_type": "test 1B Q4",
                "backends": "CPU",
                "n_prompt": 512,
                "n_gen": 0,
                "n_threads": 4,
                "n_gpu_layers": 0,
                "n_batch": 2048,
                "n_ubatch": 512,
                "flash_attn": -1,
                "avg_ts": 123.45,
                "stddev_ts": 1.25,
            }
        ]
    ) if valid_json else "not json"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "print('benchmark 1/1', file=sys.stderr, flush=True)\n"
        f"print({stdout!r}, flush=True)\n"
    )
    binary.chmod(0o755)
    return binary


def _wait_for_history(manager: bm.BenchmarkManager):
    deadline = time.monotonic() + 3
    overview = manager.overview()
    while overview.active and time.monotonic() < deadline:
        time.sleep(0.02)
        overview = manager.overview()
    return overview


def test_benchmark_runs_and_persists_json_results(tmp_path, monkeypatch):
    monkeypatch.setattr(bm, "BENCHMARK_HISTORY_FILE", tmp_path / "benchmark_history.json")
    model = tmp_path / "model.gguf"
    model.write_text("model")
    binary = _fake_benchmark(tmp_path)
    config = ServerConfig(id="bench", name="Bench", model_path=str(model), threads=4, n_gpu_layers=0)
    params = LlamaBenchRequest(
        config_id=config.id,
        binary_path=str(binary),
        prompt_tokens=[512],
        generation_tokens=[],
        threads=[4],
        gpu_layers=[0],
    )
    manager = bm.BenchmarkManager()

    started = manager.start(config, params)
    overview = _wait_for_history(manager)

    assert started.status == "running"
    assert overview.active is None
    assert overview.history[0].status == "completed"
    assert overview.history[0].results[0]["avg_ts"] == 123.45
    assert "benchmark 1/1" in overview.history[0].log_lines
    assert json.loads((tmp_path / "benchmark_history.json").read_text())["runs"][0]["id"] == started.id

    manager.clear_history()
    assert manager.overview().history == []


def test_benchmark_invalid_output_is_retained_as_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(bm, "BENCHMARK_HISTORY_FILE", tmp_path / "benchmark_history.json")
    model = tmp_path / "model.gguf"
    model.write_text("model")
    binary = _fake_benchmark(tmp_path, valid_json=False)
    config = ServerConfig(id="bad-json", name="Bad JSON", model_path=str(model))
    manager = bm.BenchmarkManager()

    manager.start(config, LlamaBenchRequest(config_id=config.id, binary_path=str(binary)))
    run = _wait_for_history(manager).history[0]

    assert run.status == "failed"
    assert "Could not parse llama-bench JSON output" in run.error
    assert "stdout: not json" in run.log_lines


def test_benchmark_command_contains_matrix_and_json_output(tmp_path):
    config = ServerConfig(id="matrix", name="Matrix", model_path=str(tmp_path / "model.gguf"))
    params = LlamaBenchRequest(
        config_id=config.id,
        prompt_tokens=[128, 512],
        generation_tokens=[64],
        threads=[4, 8],
        gpu_layers=[0, -1],
        batch_sizes=[512, 2048],
        ubatch_sizes=[256],
        flash_attention=["auto", "on"],
        repetitions=3,
        no_warmup=True,
        extra_args="--numa isolate",
    )

    command = bm.BenchmarkManager.build_command("/bin/llama-bench", config, params)

    assert command[:3] == ["/bin/llama-bench", "-m", config.model_path]
    assert command[command.index("-p") + 1] == "128,512"
    assert command[command.index("-t") + 1] == "4,8"
    assert "--no-warmup" in command
    assert command[-4:] == ["isolate", "--progress", "-o", "json"]


def test_benchmark_request_caps_matrix_and_managed_flags():
    with pytest.raises(ValidationError, match="maximum is 256"):
        LlamaBenchRequest(
            config_id="too-large",
            prompt_tokens=list(range(1, 18)),
            generation_tokens=[],
            threads=[1, 2, 3, 4],
            gpu_layers=[0, 1, 2, 3],
        )

    with pytest.raises(ValidationError, match="managed by LLM Hub"):
        LlamaBenchRequest(config_id="flags", extra_args="-o csv")
