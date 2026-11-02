"""Manages llama-server subprocesses for each configuration."""

import collections
import errno
import os
import pty
import re
import shlex
import shutil
import socket
import subprocess
import signal
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .models import ServerConfig

# Maximum number of output lines to retain per server
MAX_OUTPUT_LINES = 2000


class OutputBuffer:
    """Thread-safe retained output with absolute line offsets and stable identity."""

    def __init__(self, max_lines: int = MAX_OUTPUT_LINES):
        self._lines: collections.deque[str] = collections.deque(maxlen=max_lines)
        self._total = 0
        self._lock = threading.Lock()

    def write_line(self, text: str, *, replace_last: bool = False) -> None:
        with self._lock:
            if replace_last and self._lines:
                self._lines[-1] = text
            else:
                self._lines.append(text)
                self._total += 1

    def resize(self, max_lines: int) -> None:
        with self._lock:
            if self._lines.maxlen != max_lines:
                self._lines = collections.deque(self._lines, maxlen=max_lines)

    def clear(self) -> None:
        with self._lock:
            self._lines.clear()

    def read(self, offset: int = 0) -> tuple[list[str], int]:
        with self._lock:
            lines = list(self._lines)
            first_offset = self._total - len(lines)
            # A cursor ahead of this process's output belongs to an older run.
            start = 0 if offset > self._total else max(0, offset - first_offset)
            return lines[start:], self._total

    def __iter__(self):
        return iter(self.read()[0])


@dataclass
class RunningServer:
    """Tracks a running llama-server process."""

    config_id: str
    process: subprocess.Popen
    pid: int
    output_lines: OutputBuffer = field(default_factory=OutputBuffer)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    ready_at: str | None = None
    _reader_threads: list[threading.Thread] = field(default_factory=list)


@dataclass
class ProcessDiagnostics:
    """Retained process lifecycle details."""

    stopped_at: str | None = None
    last_exit_code: int | None = None
    failure_summary: str | None = None


def _stream_reader(stream, output_lines: OutputBuffer):
    """Background thread that reads terminal output into a stable buffer."""
    pending = ""
    pending_visible = False

    def show_pending() -> None:
        nonlocal pending_visible
        if not pending:
            return
        output_lines.write_line(pending, replace_last=pending_visible)
        pending_visible = True

    def commit_line(text: str) -> None:
        nonlocal pending, pending_visible
        output_lines.write_line(text, replace_last=pending_visible)
        pending_visible = False
        pending = ""

    try:
        while True:
            chunk = stream.read(4096)
            if not chunk:
                break
            try:
                text = chunk.decode('utf-8', errors='replace')
            except Exception:
                text = str(chunk)

            parts = re.split(r"(\r\n|\n|\r)", text)
            for part in parts:
                if not part:
                    continue
                if part in {"\r\n", "\n", "\r"}:
                    commit_line(pending)
                else:
                    pending += part
                    show_pending()
    except OSError as exc:
        if exc.errno != errno.EIO:
            pass
    except Exception:
        pass
    finally:
        if pending:
            show_pending()
        try:
            stream.close()
        except Exception:
            pass


class ProcessManager:
    """Singleton manager for llama-server subprocesses."""

    def __init__(self):
        self._processes: dict[str, RunningServer] = {}
        # Keep output for stopped servers so user can review after process exits
        self._stopped_output: dict[str, OutputBuffer] = {}
        # Config IDs detected as externally running at startup (no managed process)
        self._adopted: set[str] = set()
        self._diagnostics: dict[str, ProcessDiagnostics] = {}
        self._max_output_lines = MAX_OUTPUT_LINES
        # Routes run concurrently in FastAPI's threadpool; guard all shared state.
        self._lock = threading.RLock()

    def set_output_retention(self, max_lines: int) -> None:
        """Update retained terminal output line count for running and stopped servers."""
        with self._lock:
            self._max_output_lines = max(100, int(max_lines))
            for server in list(self._processes.values()):
                server.output_lines.resize(self._max_output_lines)
            for output in list(self._stopped_output.values()):
                output.resize(self._max_output_lines)

    def _build_command(self, config: ServerConfig) -> list[str]:
        """Build the llama-server CLI command from a config."""
        return self.build_command(config, require_binary=True)

    def build_command(self, config: ServerConfig, require_binary: bool = False) -> list[str]:
        """Build the llama-server CLI command from a config.

        Args:
            config: Server configuration to render.
            require_binary: When true, require llama-server on PATH. Command previews
                use false so they still work before llama.cpp is installed.
        """
        llama_server = shutil.which("llama-server") or "llama-server"
        if require_binary and llama_server == "llama-server":
            resolved = shutil.which("llama-server")
            if resolved:
                llama_server = resolved
        if require_binary and not shutil.which("llama-server"):
            raise FileNotFoundError(
                "llama-server not found in PATH. "
                "Please install llama.cpp and ensure llama-server is accessible."
            )

        cmd = [
            llama_server,
            "--model", config.model_path,
            "--host", config.host,
            "--port", str(config.port),
            "--n-gpu-layers", str(config.n_gpu_layers),
            "--ctx-size", str(config.ctx_size),
            "--threads", str(config.threads),
            "--parallel", str(config.parallel),
        ]

        if config.cont_batching:
            cmd.append("--cont-batching")

        if config.mmproj_path.strip():
            cmd.extend(["--mmproj", config.mmproj_path.strip()])

        if config.advanced_args:
            cmd.extend(config.advanced_args)

        if config.extra_args.strip():
            cmd.extend(shlex.split(config.extra_args))

        # Explicit config limits take precedence over freeform generation flags.
        if config.n_predict != -1:
            cmd.extend(["--n-predict", str(config.n_predict)])

        return cmd

    def command_text(self, config: ServerConfig) -> str:
        """Return a shell-escaped command preview."""
        return shlex.join(self.build_command(config, require_binary=False))

    @staticmethod
    def is_port_occupied(host: str, port: int, timeout: float = 0.25) -> bool:
        """Return true when a TCP listener accepts connections at host:port."""
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            return False

    def start(self, config: ServerConfig) -> RunningServer:
        """Start a llama-server process for the given config."""
        with self._lock:
            if config.id in self._processes:
                existing = self._processes[config.id]
                if existing.process.poll() is None:
                    raise RuntimeError(
                        f"Server '{config.name}' is already running (PID {existing.pid})"
                    )
                # Process has exited, preserve output then clean up
                self._retire(config.id, existing)

            if config.id in self._adopted:
                raise RuntimeError(
                    f"Server '{config.name}' is already running externally at {config.host}:{config.port}"
                )

            if self.is_port_occupied(config.host, config.port):
                raise RuntimeError(
                    f"Port {config.host}:{config.port} is already in use. "
                    "Stop the process using it or choose another port."
                )

            if not Path(config.model_path).is_file():
                raise RuntimeError(f"Model file does not exist: {config.model_path}")
            if config.mmproj_path.strip() and not Path(config.mmproj_path).is_file():
                raise RuntimeError(f"MMProj file does not exist: {config.mmproj_path.strip()}")

            # Clear any previous stopped output for this config
            self._stopped_output.pop(config.id, None)
            self._diagnostics.pop(config.id, None)

            cmd = self._build_command(config)
            env = os.environ.copy()
            env.update(config.env_vars)
            master_fd: int | None = None
            slave_fd: int | None = None
            try:
                master_fd, slave_fd = pty.openpty()
            except OSError:
                process = subprocess.Popen(
                    cmd,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,  # Merge stderr into stdout
                    bufsize=1,
                )
                output_stream = process.stdout
            else:
                try:
                    process = subprocess.Popen(
                        cmd,
                        env=env,
                        stdin=subprocess.DEVNULL,
                        stdout=slave_fd,
                        stderr=slave_fd,
                        close_fds=True,
                        bufsize=0,
                    )
                    os.close(slave_fd)
                    slave_fd = None
                    output_stream = os.fdopen(master_fd, "rb", buffering=0)
                    master_fd = None
                finally:
                    if slave_fd is not None:
                        os.close(slave_fd)
                    if master_fd is not None:
                        os.close(master_fd)

            server = RunningServer(
                config_id=config.id,
                process=process,
                pid=process.pid,
                output_lines=OutputBuffer(self._max_output_lines),
            )

            # Start background reader thread
            t = threading.Thread(
                target=_stream_reader,
                args=(output_stream, server.output_lines),
                daemon=True,
            )
            t.start()
            server._reader_threads.append(t)

            self._processes[config.id] = server
            return server

    def adopt(self, config_id: str) -> None:
        """Mark a server config as externally running (detected at startup)."""
        with self._lock:
            self._adopted.add(config_id)

    def _retire(self, config_id: str, server: RunningServer) -> None:
        """Keep an exited server's output and diagnostics. Caller holds the lock."""
        if self._processes.get(config_id) is not server:
            return  # already retired by a concurrent caller
        self._join_readers(server)
        self._stopped_output[config_id] = server.output_lines
        exit_code = server.process.returncode
        self._diagnostics[config_id] = ProcessDiagnostics(
            stopped_at=datetime.now(timezone.utc).isoformat(),
            last_exit_code=exit_code,
            failure_summary=self._summarize_failure(server.output_lines, exit_code),
        )
        del self._processes[config_id]

    def stop(self, config_id: str) -> bool:
        """Stop a running server. Returns True if stopped, False if not running.

        For adopted (externally started) servers, this untracks them rather than
        sending a signal, since LLMHub did not start the process.
        """
        with self._lock:
            if config_id in self._adopted:
                self._adopted.discard(config_id)
                self._diagnostics[config_id] = ProcessDiagnostics(
                    stopped_at=datetime.now(timezone.utc).isoformat(),
                    last_exit_code=None,
                    failure_summary="Untracked externally started server",
                )
                return True

            server = self._processes.get(config_id)
            if server is None:
                return False

        # Wait for exit without holding the lock so status polls stay responsive.
        if server.process.poll() is None:
            server.process.send_signal(signal.SIGTERM)
            try:
                server.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.process.kill()
                server.process.wait(timeout=5)

        with self._lock:
            self._retire(config_id, server)
        return True

    def is_running(self, config_id: str) -> bool:
        """Check if a server is currently running (managed or adopted)."""
        with self._lock:
            if config_id in self._adopted:
                return True
            server = self._processes.get(config_id)
            if server is None:
                return False
            if server.process.poll() is not None:
                self._retire(config_id, server)
                return False
            return True

    def get_pid(self, config_id: str) -> int | None:
        """Get the PID of a running server. Returns None for adopted servers."""
        with self._lock:
            server = self._processes.get(config_id)
            return server.pid if server else None

    def get_output(self, config_id: str, offset: int = 0) -> tuple[list[str], int]:
        """Get output lines for a server (running or recently stopped).

        Args:
            config_id: The server config ID.
            offset: Absolute line index since process start (for incremental fetching).

        Returns:
            Tuple of (retained lines from offset onward, next absolute offset).
            The offset keeps increasing when old lines are evicted or cleared.
        """
        with self._lock:
            server = self._processes.get(config_id)
            output = server.output_lines if server else self._stopped_output.get(config_id)
        if output is None:
            return [], 0
        return output.read(offset)

    def get_recent_output(self, config_id: str, limit: int = 12) -> list[str]:
        """Return the latest retained output lines for a server."""
        lines, _ = self.get_output(config_id, 0)
        return lines[-limit:]

    def clear_output(self, config_id: str) -> bool:
        """Clear retained output for a running or stopped server."""
        with self._lock:
            server = self._processes.get(config_id)
            output = server.output_lines if server else self._stopped_output.get(config_id)
        if output is None:
            return False
        output.clear()
        return True

    def is_adopted(self, config_id: str) -> bool:
        """Return true when the config maps to an externally started server."""
        with self._lock:
            return config_id in self._adopted

    def get_started_at(self, config_id: str) -> str | None:
        with self._lock:
            server = self._processes.get(config_id)
            return server.started_at if server else None

    def mark_ready(self, config_id: str) -> str | None:
        with self._lock:
            server = self._processes.get(config_id)
            if server is None:
                return None
            if server.ready_at is None:
                server.ready_at = datetime.now(timezone.utc).isoformat()
            return server.ready_at

    def get_ready_at(self, config_id: str) -> str | None:
        with self._lock:
            server = self._processes.get(config_id)
            return server.ready_at if server else None

    def get_diagnostics(self, config_id: str) -> ProcessDiagnostics:
        with self._lock:
            return self._diagnostics.get(config_id, ProcessDiagnostics())

    @staticmethod
    def _join_readers(server: RunningServer) -> None:
        """Let output readers drain and exit after their subprocess closes."""
        for reader in server._reader_threads:
            if reader.is_alive():
                reader.join(timeout=1)

    @staticmethod
    def _summarize_failure(lines: OutputBuffer | list[str], exit_code: int | None) -> str | None:
        if exit_code == 0:
            return None
        recent = [line for line in list(lines)[-12:] if line.strip()]
        if recent:
            return recent[-1][:500]
        if exit_code is not None:
            return f"Process exited with code {exit_code}"
        return None

    def stop_all(self) -> None:
        """Stop all managed servers on app shutdown. Adopted servers are not killed."""
        with self._lock:
            config_ids = list(self._processes.keys())
        for config_id in config_ids:
            self.stop(config_id)
        with self._lock:
            self._adopted.clear()


# Global singleton
process_manager = ProcessManager()
