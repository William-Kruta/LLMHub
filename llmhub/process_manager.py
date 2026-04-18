"""Manages llama-server subprocesses for each configuration."""

import collections
import shlex
import shutil
import subprocess
import signal
import threading
from dataclasses import dataclass, field

from .models import ServerConfig

# Maximum number of output lines to retain per server
MAX_OUTPUT_LINES = 2000


@dataclass
class RunningServer:
    """Tracks a running llama-server process."""

    config_id: str
    process: subprocess.Popen
    pid: int
    output_lines: collections.deque = field(default_factory=lambda: collections.deque(maxlen=MAX_OUTPUT_LINES))
    _reader_threads: list[threading.Thread] = field(default_factory=list)


def _stream_reader(stream, output_lines: collections.deque):
    """Background thread that reads a stream line-by-line into the deque."""
    try:
        for line in iter(stream.readline, b''):
            try:
                text = line.decode('utf-8', errors='replace').rstrip('\n').rstrip('\r')
            except Exception:
                text = str(line)
            output_lines.append(text)
        stream.close()
    except Exception:
        pass


class ProcessManager:
    """Singleton manager for llama-server subprocesses."""

    def __init__(self):
        self._processes: dict[str, RunningServer] = {}
        # Keep output for stopped servers so user can review after process exits
        self._stopped_output: dict[str, list[str]] = {}
        # Config IDs detected as externally running at startup (no managed process)
        self._adopted: set[str] = {}

    def _build_command(self, config: ServerConfig) -> list[str]:
        """Build the llama-server CLI command from a config."""
        llama_server = shutil.which("llama-server")
        if not llama_server:
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

        if config.extra_args.strip():
            cmd.extend(shlex.split(config.extra_args))

        return cmd

    def start(self, config: ServerConfig) -> RunningServer:
        """Start a llama-server process for the given config."""
        if config.id in self._processes:
            existing = self._processes[config.id]
            if existing.process.poll() is None:
                raise RuntimeError(
                    f"Server '{config.name}' is already running (PID {existing.pid})"
                )
            # Process has exited, preserve output then clean up
            self._stopped_output[config.id] = list(existing.output_lines)
            del self._processes[config.id]

        # Clear any previous stopped output for this config
        self._stopped_output.pop(config.id, None)

        cmd = self._build_command(config)
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # Merge stderr into stdout
        )

        server = RunningServer(
            config_id=config.id,
            process=process,
            pid=process.pid,
        )

        # Start background reader thread
        t = threading.Thread(
            target=_stream_reader,
            args=(process.stdout, server.output_lines),
            daemon=True,
        )
        t.start()
        server._reader_threads.append(t)

        self._processes[config.id] = server
        return server

    def adopt(self, config_id: str) -> None:
        """Mark a server config as externally running (detected at startup)."""
        self._adopted.add(config_id)

    def stop(self, config_id: str) -> bool:
        """Stop a running server. Returns True if stopped, False if not running.

        For adopted (externally started) servers, this untracks them rather than
        sending a signal, since LLMHub did not start the process.
        """
        if config_id in self._adopted:
            self._adopted.discard(config_id)
            return True

        if config_id not in self._processes:
            return False

        server = self._processes[config_id]
        if server.process.poll() is None:
            server.process.send_signal(signal.SIGTERM)
            try:
                server.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.process.kill()
                server.process.wait(timeout=5)

        # Preserve output for review
        self._stopped_output[config_id] = list(server.output_lines)
        del self._processes[config_id]
        return True

    def is_running(self, config_id: str) -> bool:
        """Check if a server is currently running (managed or adopted)."""
        if config_id in self._adopted:
            return True
        if config_id not in self._processes:
            return False
        server = self._processes[config_id]
        if server.process.poll() is not None:
            # Process has exited, preserve output and clean up
            self._stopped_output[config_id] = list(server.output_lines)
            del self._processes[config_id]
            return False
        return True

    def get_pid(self, config_id: str) -> int | None:
        """Get the PID of a running server. Returns None for adopted servers."""
        if config_id in self._processes:
            return self._processes[config_id].pid
        return None

    def get_output(self, config_id: str, offset: int = 0) -> tuple[list[str], int]:
        """Get output lines for a server (running or recently stopped).

        Args:
            config_id: The server config ID.
            offset: Line index to start from (for incremental fetching).

        Returns:
            Tuple of (lines from offset onward, total line count).
        """
        if config_id in self._processes:
            lines = list(self._processes[config_id].output_lines)
        elif config_id in self._stopped_output:
            lines = self._stopped_output[config_id]
        else:
            return [], 0

        total = len(lines)
        return lines[offset:], total

    def stop_all(self) -> None:
        """Stop all managed servers on app shutdown. Adopted servers are not killed."""
        for config_id in list(self._processes.keys()):
            self.stop(config_id)
        self._adopted.clear()


# Global singleton
process_manager = ProcessManager()
