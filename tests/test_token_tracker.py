"""Unit tests for token usage persistence."""

import threading

from llmhub import token_tracker as tt


def test_record_usage_persists_by_config(tmp_path, monkeypatch):
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")

    first = tt.record_usage("config-a", prompt_tokens=10, completion_tokens=4)
    second = tt.record_usage("config-a", prompt_tokens=3, completion_tokens=2, total_tokens=6)
    other = tt.record_usage("config-b", prompt_tokens=1, completion_tokens=1)

    assert first.prompt_tokens == 10
    assert second.prompt_tokens == 13
    assert second.completion_tokens == 6
    assert second.total_tokens == 20
    assert second.request_count == 2
    assert second.last_used_at is not None
    assert other.total_tokens == 2
    assert tt.get_usage("config-a").request_count == 2
    assert tt.get_usage("missing").total_tokens == 0


def test_record_response_usage_ignores_missing_usage(tmp_path, monkeypatch):
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")

    usage = tt.record_response_usage("config-a", {"id": "no-usage"})

    assert usage.total_tokens == 0
    assert usage.request_count == 0


def test_reset_usage(tmp_path, monkeypatch):
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")

    tt.record_usage("config-a", prompt_tokens=1, completion_tokens=2)
    reset = tt.reset_usage("config-a")

    assert reset.total_tokens == 0
    assert tt.get_usage("config-a").total_tokens == 0


def test_corrupt_usage_file_is_tolerated(tmp_path, monkeypatch):
    path = tmp_path / "token_usage.json"
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", path)
    path.write_text("{not valid json")

    assert tt.get_usage("config-a").total_tokens == 0

    recorded = tt.record_usage("config-a", prompt_tokens=2, completion_tokens=1)
    assert recorded.total_tokens == 3
    assert tt.get_usage("config-a").request_count == 1


def test_concurrent_record_usage_loses_no_counts(tmp_path, monkeypatch):
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")

    def worker():
        for _ in range(25):
            tt.record_usage("config-a", prompt_tokens=1, completion_tokens=1)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    usage = tt.get_usage("config-a")
    assert usage.request_count == 200
    assert usage.prompt_tokens == 200
    assert usage.total_tokens == 400


def test_get_all_usage(tmp_path, monkeypatch):
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")

    tt.record_usage("config-a", prompt_tokens=1)
    tt.record_usage("config-b", prompt_tokens=2)

    all_usage = tt.get_all_usage()
    assert all_usage["config-a"].prompt_tokens == 1
    assert all_usage["config-b"].prompt_tokens == 2


def test_reset_many(tmp_path, monkeypatch):
    monkeypatch.setattr(tt, "TOKEN_USAGE_FILE", tmp_path / "token_usage.json")

    tt.record_usage("config-a", prompt_tokens=1)
    tt.record_usage("config-b", prompt_tokens=2)
    tt.record_usage("config-c", prompt_tokens=3)

    tt.reset_many(["config-a", "config-b", "missing"])

    assert tt.get_usage("config-a").request_count == 0
    assert tt.get_usage("config-b").request_count == 0
    assert tt.get_usage("config-c").prompt_tokens == 3
