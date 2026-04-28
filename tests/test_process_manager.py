"""Tests for managed llama-server process output handling."""

import os
import time

from llmhub.models import ServerConfig
from llmhub.process_manager import ProcessManager


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
