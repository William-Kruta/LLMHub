"""Tests for managed llama-server process output handling."""

import os
import threading
import time
from unittest.mock import Mock

import pytest

from llmhub.models import ServerConfig
from llmhub.process_manager import OutputBuffer, ProcessManager, RunningServer, _stream_reader


def test_live_process_output_is_available_before_exit(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    llama_server = bin_dir / "llama-server"
    llama_server.write_text(
        "#!/usr/bin/env python3\n"
        "import time\n"
        "print('server booting')\n"
        "time.sleep(10)\n"
    )
    llama_server.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(ProcessManager, "is_port_occupied", staticmethod(lambda _host, _port, timeout=0.25: False))

    model = tmp_path / "model.gguf"
    model.write_text("model")
    config = ServerConfig(id="live-output", name="Live", model_path=str(model), port=51888)
    manager = ProcessManager()

    try:
        manager.start(config)
        deadline = time.monotonic() + 3
        lines: list[str] = []
        while time.monotonic() < deadline:
            lines, _ = manager.get_output(config.id, 0)
            if "server booting" in lines:
                break
            time.sleep(0.05)

        assert "server booting" in lines
        assert manager.is_running(config.id) is True
    finally:
        manager.stop(config.id)


def test_partial_process_output_is_available_before_newline(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    llama_server = bin_dir / "llama-server"
    llama_server.write_text(
        "#!/usr/bin/env python3\n"
        "import sys, time\n"
        "sys.stdout.write('loading model')\n"
        "sys.stdout.flush()\n"
        "time.sleep(10)\n"
    )
    llama_server.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(ProcessManager, "is_port_occupied", staticmethod(lambda _host, _port, timeout=0.25: False))

    model = tmp_path / "model.gguf"
    model.write_text("model")
    config = ServerConfig(id="partial-output", name="Partial", model_path=str(model), port=51889)
    manager = ProcessManager()

    try:
        manager.start(config)
        deadline = time.monotonic() + 3
        lines: list[str] = []
        while time.monotonic() < deadline:
            lines, _ = manager.get_output(config.id, 0)
            if "loading model" in lines:
                break
            time.sleep(0.05)

        assert "loading model" in lines
        assert manager.is_running(config.id) is True
    finally:
        manager.stop(config.id)


@pytest.mark.parametrize("retention", [2000, 100])
def test_retention_changes_preserve_live_reader_and_partial_lines(retention):
    manager = ProcessManager()
    server = RunningServer(config_id="live", process=Mock(), pid=0)
    manager._processes["live"] = server
    read_fd, write_fd = os.pipe()
    reader = threading.Thread(target=_stream_reader, args=(os.fdopen(read_fd, "rb", buffering=0), server.output_lines))
    reader.start()

    def wait_for(expected):
        deadline = time.monotonic() + 3
        while manager.get_output("live")[0] != expected and time.monotonic() < deadline:
            time.sleep(0.01)
        assert manager.get_output("live")[0] == expected

    try:
        os.write(write_fd, b"loading")
        wait_for(["loading"])
        manager.set_output_retention(retention)
        os.write(write_fd, b" model\nready\n")
        wait_for(["loading model", "ready"])
        assert manager.get_output("live", 1) == (["ready"], 2)
    finally:
        os.close(write_fd)
        reader.join(timeout=3)
    assert not reader.is_alive()


def test_output_offsets_survive_rollover_resize_clear_and_stop():
    manager = ProcessManager()
    buffer = OutputBuffer(100)
    process = Mock()
    process.poll.return_value = 0
    process.returncode = 0
    manager._processes["logs"] = RunningServer(config_id="logs", process=process, pid=0, output_lines=buffer)
    for index in range(105):
        buffer.write_line(str(index))

    assert manager.get_output("logs") == ([str(n) for n in range(5, 105)], 105)
    buffer.write_line("new")
    assert manager.get_output("logs", 105) == (["new"], 106)
    manager.set_output_retention(200)
    buffer.write_line("resized")
    assert manager.get_output("logs", 106) == (["resized"], 107)

    manager.clear_output("logs")
    assert manager.get_output("logs") == ([], 107)
    buffer.write_line("after clear")
    assert manager.get_output("logs", 107) == (["after clear"], 108)
    assert manager.is_running("logs") is False
    assert manager.get_output("logs", 107) == (["after clear"], 108)
    manager.clear_output("logs")
    assert manager.get_output("logs") == ([], 108)


@pytest.mark.parametrize("limit", [-1, 0, 1024])
def test_output_token_limit_in_server_command(limit):
    config = ServerConfig(name="Limit", model_path="/tmp/model.gguf", n_predict=limit)
    command = ProcessManager().build_command(config)
    if limit == -1:
        assert "--n-predict" not in command
    else:
        assert command[-2:] == ["--n-predict", str(limit)]


def test_adopted_servers_are_tracked_and_untracked_without_signals():
    manager = ProcessManager()
    manager.adopt("external")

    assert manager.is_running("external")
    assert manager.is_adopted("external")
    assert manager.get_pid("external") is None

    assert manager.stop("external") is True
    assert not manager.is_running("external")
    assert manager.get_diagnostics("external").failure_summary == "Untracked externally started server"


def test_concurrent_status_checks_retire_an_exited_server_once():
    manager = ProcessManager()
    process = Mock()
    process.poll.return_value = 1
    process.returncode = 1
    output = OutputBuffer()
    output.write_line("fatal: model load failed")
    manager._processes["exited"] = RunningServer(config_id="exited", process=process, pid=1, output_lines=output)

    errors: list[BaseException] = []
    results: list[bool] = []
    barrier = threading.Barrier(8)

    def check():
        barrier.wait()
        try:
            results.append(manager.is_running("exited"))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=check) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert results == [False] * 8
    assert manager.get_diagnostics("exited").failure_summary == "fatal: model load failed"
    assert manager.get_output("exited")[0] == ["fatal: model load failed"]
