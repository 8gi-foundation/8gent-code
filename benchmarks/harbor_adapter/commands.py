"""
Pure command building for the Harbor adapter. No Harbor import, no network,
so it can be unit tested anywhere.

Configuration (all optional except the version pin):

  EIGHT_VERSION              Released version to install, e.g. 0.20.43. Required.
                             "latest" and empty are refused.
  EIGHT_HARBOR_MODEL         Model id sent to the endpoint (or pass -m to Harbor).
  EIGHT_HARBOR_BASE_URL      OpenAI-compatible endpoint, e.g. https://host/v1.
  EIGHT_HARBOR_API_KEY_ENV   Name of the env var holding the key (default OPENAI_API_KEY).
  EIGHT_TASK_TIMEOUT_SEC     Per-task limit in seconds. Unset: Harbor enforces the
                             task's own agent timeout from its task.toml.
  EIGHT_HARBOR_YES_FLAG      "1" adds --yes for 8gent builds that predate
                             EIGHT_HEADLESS_APPROVE. Off by default.
"""

from __future__ import annotations

import base64
import json
import re
import shlex

PROVIDER_NAME = "harbor-endpoint"
LOG_DIR = "/logs/agent"
EVENTS_FILE = f"{LOG_DIR}/8gent-events.jsonl"
INSTRUCTION_FILE = f"{LOG_DIR}/instruction.txt"
PACKAGE = "@8gi-foundation/8gent-code"
_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$")


def pinned_version(env: dict, arg: str | None = None) -> str:
    """Return the pinned version or raise. Never resolves to latest."""
    value = (arg or env.get("EIGHT_VERSION") or "").strip()
    if not value or not _VERSION_RE.match(value):
        raise ValueError(
            "Set EIGHT_VERSION (or pass eight_version=) to a released version "
            "such as 0.20.43. 'latest' and ranges are not accepted."
        )
    return value


def install_command(version: str) -> str:
    """Install the pinned release, skipping the fetch when it is already there."""
    pkg = shlex.quote(f"{PACKAGE}@{version}")
    return (
        f'if [ "$(8gent --version 2>/dev/null | grep -o \'[0-9][0-9.]*[0-9]\' | head -1)" = {shlex.quote(version)} ]; '
        f"then echo 'prebuilt 8gent {version}'; "
        f"else bun install -g {pkg}; fi"
    )


def task_timeout(env: dict, arg: int | None = None) -> int | None:
    """Seconds, or None to let Harbor apply the task's own agent timeout."""
    raw = arg if arg is not None else env.get("EIGHT_TASK_TIMEOUT_SEC")
    if raw in (None, ""):
        return None
    seconds = int(raw)
    if seconds <= 0:
        raise ValueError("EIGHT_TASK_TIMEOUT_SEC must be positive")
    return seconds


def resolve_model(model_name: str | None, env: dict) -> str | None:
    return env.get("EIGHT_HARBOR_MODEL") or model_name or None


def providers_json(base_url: str, model: str | None, key_env: str) -> str:
    entry = {
        "baseUrl": base_url,
        "compat": "openai",
        "apiKeyEnv": key_env,
        "enabled": True,
        "models": [model] if model else [],
        "defaultModel": model or "",
    }
    return json.dumps({PROVIDER_NAME: entry}, indent=2)


def provider_setup_command(env: dict, model: str | None) -> str | None:
    base_url = (env.get("EIGHT_HARBOR_BASE_URL") or "").strip()
    if not base_url:
        return None
    key_env = env.get("EIGHT_HARBOR_API_KEY_ENV") or "OPENAI_API_KEY"
    body = base64.b64encode(providers_json(base_url, model, key_env).encode()).decode()
    return f"mkdir -p ~/.8gent && printf %s {body} | base64 -d > ~/.8gent/providers.json"


def run_env(env: dict, model: str | None) -> dict:
    """Environment for the 8gent process. Approval is an explicit opt-in."""
    out = {
        "HOME": "/root",
        "PATH": "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin",
        "DEBIAN_FRONTEND": "noninteractive",
        # Explicit headless opt-in (PR #39). Ignored by builds that predate it.
        "EIGHT_HEADLESS_APPROVE": "1",
        # The done gate runs project code; a benchmark grades on its own.
        "EIGHT_DONE_GATE": "0",
    }
    if env.get("EIGHT_HARBOR_BASE_URL"):
        key_env = env.get("EIGHT_HARBOR_API_KEY_ENV") or "OPENAI_API_KEY"
        if env.get(key_env):
            out[key_env] = env[key_env]
    return out


def run_command(instruction: str, env: dict, model: str | None) -> str:
    """Shell command: write the task text to a file, run 8gent on it, keep the event log."""
    b64 = base64.b64encode(instruction.encode()).decode()
    flags = ["-p", "--mode", "json", "--no-session"]
    if env.get("EIGHT_HARBOR_BASE_URL"):
        flags += ["--provider", PROVIDER_NAME]
    if model:
        flags += ["--model", model]
    if env.get("EIGHT_HARBOR_YES_FLAG") == "1":
        flags.append("--yes")
    flag_str = " ".join(shlex.quote(f) for f in flags)
    return (
        f"mkdir -p {LOG_DIR} && printf %s {b64} | base64 -d > {INSTRUCTION_FILE} && "
        f'8gent {flag_str} "$(cat {INSTRUCTION_FILE})" < /dev/null 2>{LOG_DIR}/8gent-stderr.log '
        f"| tee {EVENTS_FILE}"
    )


def parse_events(text: str) -> dict:
    """Sum token usage from the JSON event stream. Cost is reported only if present."""
    prompt = completion = 0
    cost = None
    final = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        usage = ev.get("usage")
        if isinstance(usage, dict):
            prompt += int(usage.get("promptTokens") or 0)
            completion += int(usage.get("completionTokens") or 0)
            if isinstance(usage.get("costUsd"), (int, float)):
                cost = (cost or 0.0) + float(usage["costUsd"])
        if ev.get("type") == "result":
            final = ev.get("subtype")
    return {
        "n_input_tokens": prompt,
        "n_output_tokens": completion,
        "cost_usd": cost,
        "result": final,
        "trajectory_path": EVENTS_FILE,
    }
