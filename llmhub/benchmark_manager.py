"""Runs llama-bench matrices and retains recent structured results."""

import json
import os
import shlex
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import storage
from .models import LlamaBenchOverview, LlamaBenchRequest, LlamaBenchRun, ServerConfig


BENCHMARK_HISTORY_FILE = Path(__file__).parent / "benchmark_history.json"
MAX_HISTORY_RUNS = 20
MAX_LOG_LINES = 500


class BenchmarkManager:
    """Coordinate one resource-intensive llama-bench process at a time."""

    def __init__(self):
        self._lock = threading.RLock()
        self._active: LlamaBenchRun | None = None
        self._history: list[LlamaBenchRun] | None = None
        self._process: subprocess.Popen | None = None
        self._worker: threading.Thread | None = None
        self._cancel_requested: set[str] = set()

    @staticmethod
    def resolve_binary(requested_path: str = "") -> str | None:
        """Resolve an explicit path, LLMHUB_LLAMA_BENCH, or llama-bench on PATH."""
        candidate = requested_path.strip() or os.environ.get("LLMHUB_LLAMA_BENCH", "").strip()
        if candidate:
            expanded = str(Path(candidate).expanduser())
            resolved = shutil.which(expanded) if Path(expanded).name == expanded else expanded
            if resolved and Path(resolved).is_file() and os.access(resolved, os.X_OK):
                return str(Path(resolved).resolve())
            return None
        resolved = shutil.which("llama-bench")
        return str(Path(resolved).resolve()) if resolved else None

    @staticmethod
    def build_command(binary: str, config: ServerConfig, params: LlamaBenchRequest) -> list[str]:
        """Render a llama-bench matrix command with machine-readable output."""
        command = [binary, "-m", config.model_path]
        command.extend(["-p", ",".join(str(value) for value in params.prompt_tokens) or "0"])
        command.extend(["-n", ",".join(str(value) for value in params.generation_tokens) or "0"])
        command.extend(["-t", ",".join(str(value) for value in params.threads)])
        command.extend(["-ngl", ",".join(str(value) for value in params.gpu_layers)])
        command.extend(["-b", ",".join(str(value) for value in params.batch_sizes)])
        command.extend(["-ub", ",".join(str(value) for value in params.ubatch_sizes)])
        command.extend(["-fa", ",".join(params.flash_attention)])
        command.extend(["-r", str(params.repetitions)])
        if params.no_warmup:
            command.append("--no-warmup")
        if params.extra_args.strip():
            command.extend(shlex.split(params.extra_args))
        command.extend(["--progress", "-o", "json"])
        return command

    def overview(self) -> LlamaBenchOverview:
        """Return binary availability, the active run, and recent completed runs."""
        with self._lock:
            history = [item.model_copy(deep=True) for item in self._load_history()]
            active = self._active.model_copy(deep=True) if self._active else None
        binary = self.resolve_binary()
        return LlamaBenchOverview(
            available=binary is not None,
            binary_path=binary,
            active=active,
            history=history,
        )

    def start(self, config: ServerConfig, params: LlamaBenchRequest) -> LlamaBenchRun:
        """Start a benchmark in a background thread."""
        binary = self.resolve_binary(params.binary_path)
        if not binary:
            if params.binary_path.strip():
                raise FileNotFoundError(f"llama-bench is not executable at: {params.binary_path}")
            raise FileNotFoundError(
                "llama-bench not found. Add it to PATH, set LLMHUB_LLAMA_BENCH, "
                "or enter its full path on the Benchmark page."
            )
        if not Path(config.model_path).is_file():
            raise FileNotFoundError(f"Model file does not exist: {config.model_path}")

        command = self.build_command(binary, config, params)
        run = LlamaBenchRun(
            config_id=config.id,
            config_name=config.name,
            model_path=config.model_path,
            params=params,
            command=command,
            command_text=shlex.join(command),
            started_at=storage.now_iso(),
        )

        with self._lock:
            if self._active and self._active.status in {"running", "stopping"}:
                raise RuntimeError(f"Benchmark '{self._active.config_name}' is already running")
            self._active = run
            self._worker = threading.Thread(
                target=self._execute,
                args=(run.id, command, dict(config.env_vars)),
                daemon=True,
            )
            self._worker.start()
            return run.model_copy(deep=True)

    def stop(self, run_id: str) -> LlamaBenchRun | None:
        """Request cancellation of the active benchmark."""
        with self._lock:
            if not self._active or self._active.id != run_id:
                return None
            self._cancel_requested.add(run_id)
            self._active.status = "stopping"
            process = self._process
            snapshot = self._active.model_copy(deep=True)
        if process and process.poll() is None:
            self._terminate_process(process)
        return snapshot

    def clear_history(self) -> None:
        """Remove completed benchmark history without affecting an active run."""
        with self._lock:
            self._history = []
            self._persist_history()

    def shutdown(self) -> None:
        """Stop an active benchmark during application shutdown."""
        with self._lock:
            active_id = self._active.id if self._active else None
            worker = self._worker
        if active_id:
            self.stop(active_id)
        if worker and worker.is_alive():
            worker.join(timeout=5)

    def _execute(self, run_id: str, command: list[str], env_vars: dict[str, str]) -> None:
        started = time.monotonic()
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        process: subprocess.Popen | None = None
        try:
            env = os.environ.copy()
            env.update(env_vars)
            process = subprocess.Popen(
                command,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                start_new_session=True,
            )
            with self._lock:
                if self._active and self._active.id == run_id:
                    self._process = process
                cancel_now = run_id in self._cancel_requested
            if cancel_now:
                self._terminate_process(process)

            readers = [
                threading.Thread(
                    target=self._capture_stream,
                    args=(run_id, process.stdout, stdout_lines, False),
                    daemon=True,
                ),
                threading.Thread(
                    target=self._capture_stream,
                    args=(run_id, process.stderr, stderr_lines, True),
                    daemon=True,
                ),
            ]
            for reader in readers:
                reader.start()
            exit_code = process.wait()
            for reader in readers:
                reader.join(timeout=2)

            cancelled = self._was_cancelled(run_id)
            results: list[dict] = []
            error: str | None = None
            status = "cancelled" if cancelled else "completed"
            if not cancelled and exit_code == 0:
                try:
                    parsed = json.loads("\n".join(stdout_lines))
                    if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
                        raise ValueError("expected a JSON array of result objects")
                    results = parsed
                except (json.JSONDecodeError, ValueError) as exc:
                    status = "failed"
                    error = f"Could not parse llama-bench JSON output: {exc}"
            elif not cancelled:
                status = "failed"
                error = next((line for line in reversed(stderr_lines) if line.strip()), None)
                error = error or f"llama-bench exited with code {exit_code}"

            self._finish_run(
                run_id,
                status=status,
                exit_code=exit_code,
                results=results,
                error=error,
                duration=time.monotonic() - started,
                failed_stdout=stdout_lines if status == "failed" else [],
            )
        except Exception as exc:
            self._finish_run(
                run_id,
                status="cancelled" if self._was_cancelled(run_id) else "failed",
                exit_code=process.returncode if process else None,
                results=[],
                error=str(exc),
                duration=time.monotonic() - started,
                failed_stdout=stdout_lines,
            )

    def _capture_stream(self, run_id: str, stream, target: list[str], expose: bool) -> None:
        if stream is None:
            return
        try:
            for line in iter(stream.readline, ""):
                text = line.rstrip("\r\n")
                target.append(text)
                if expose and text:
                    self._append_log(run_id, text)
        finally:
            stream.close()

    def _append_log(self, run_id: str, line: str) -> None:
        with self._lock:
            if self._active and self._active.id == run_id:
                self._active.log_lines.append(line)
                self._active.log_lines = self._active.log_lines[-MAX_LOG_LINES:]

    def _finish_run(
        self,
        run_id: str,
        *,
        status: str,
        exit_code: int | None,
        results: list[dict],
        error: str | None,
        duration: float,
        failed_stdout: list[str],
    ) -> None:
        with self._lock:
            if not self._active or self._active.id != run_id:
                return
            run = self._active
            run.status = status
            run.exit_code = exit_code
            run.results = results
            run.error = error
            run.finished_at = storage.now_iso()
            run.duration_seconds = round(duration, 2)
            if failed_stdout:
                run.log_lines.extend(f"stdout: {line}" for line in failed_stdout[-40:] if line)
                run.log_lines = run.log_lines[-MAX_LOG_LINES:]
            history = self._load_history()
            history.insert(0, run.model_copy(deep=True))
            self._history = history[:MAX_HISTORY_RUNS]
            self._active = None
            self._process = None
            self._worker = None
            self._cancel_requested.discard(run_id)
            self._persist_history()

    def _was_cancelled(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._cancel_requested

    @staticmethod
    def _terminate_process(process: subprocess.Popen) -> None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        except OSError:
            process.terminate()

    def _history_path(self) -> Path:
        return storage.data_file(BENCHMARK_HISTORY_FILE)

    def _load_history(self) -> list[LlamaBenchRun]:
        if self._history is not None:
            return self._history
        try:
            raw = storage.read_json_dict(self._history_path()).get("runs", [])
            self._history = [LlamaBenchRun(**item) for item in raw if isinstance(item, dict)]
        except Exception:
            self._history = []
        return self._history

    def _persist_history(self) -> None:
        path = self._history_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        storage.write_json_atomic(path, {"runs": [run.model_dump() for run in self._history or []]})


benchmark_manager = BenchmarkManager()
