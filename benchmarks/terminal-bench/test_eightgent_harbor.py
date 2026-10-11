"""Run with the Harbor venv:  <venv>/bin/python -m pytest benchmarks/terminal-bench"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import eightgent_harbor as a  # noqa: E402


def test_local_providers_only():
    assert a.split_model("ollama/qwen3.5:9b") == ("ollama", "qwen3.5:9b")
    assert a.split_model("lmstudio/ornith-1.0-9b") == ("lmstudio", "ornith-1.0-9b")
    for bad in ("openrouter/x", "anthropic/claude", "openai/gpt", "qwen3.5:9b", None):
        with pytest.raises(ValueError):
            a.split_model(bad)


def test_env_is_allowlist_and_points_at_host():
    env = a.build_env("ollama", None)
    assert env["OLLAMA_BASE_URL"] == "http://host.docker.internal:11434"
    assert not [k for k in env if "KEY" in k or "TOKEN" in k]
    assert a.build_env("lmstudio", "http://h:1")["LM_STUDIO_HOST"] == "http://h:1"


def test_command_quotes_instruction_and_is_headless():
    cmd = a.build_run_command("ollama", "qwen3.5:9b", "echo 'hi'; touch x", None)
    assert "run --yes" in cmd and "--provider ollama" in cmd
    assert "--output-format stream-json" in cmd
    assert "'echo '\"'\"'hi'\"'\"'; touch x'" in cmd
