"""Harbor adapter: runs 8gent-code headless inside each Terminal-Bench 2.0 task container.

Plug in with Harbor's import-path flag:

    harbor run -d terminal-bench/terminal-bench-2 \
        --agent eightgent_harbor:EightGentCode \
        -m ollama/qwen3.5:9b ...

The model never leaves the owned machine. 8gent talks to the host's Ollama or
LM Studio over host.docker.internal. No cloud key is read or forwarded, and the
container environment is built from an explicit allowlist, not from the host.

Configuration (host environment variables, all optional):

    EIGHTGENT_TB_BUNDLE    path to the built dist/cli.js   (default: <repo>/dist/cli.js)
    EIGHTGENT_TB_BASE_URL  model endpoint as seen from inside the container
                           (default: http://host.docker.internal:11434 for ollama,
                            http://host.docker.internal:1234 for lmstudio)
    EIGHTGENT_TB_MAX_TURNS cap on turns per task              (default: unset)
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

LOCAL_PROVIDERS = {
    "ollama": ("OLLAMA_BASE_URL", "http://host.docker.internal:11434"),
    "lmstudio": ("LM_STUDIO_HOST", "http://host.docker.internal:1234"),
}

INSTALL_DIR = "/installed-agent/8gent"
BUNDLE_REMOTE = f"{INSTALL_DIR}/cli.js"
BUN_BIN = "/root/.bun/bin/bun"
LOG_REMOTE = "/logs/agent/8gent-run.ndjson"


def default_bundle() -> Path:
    # benchmarks/terminal-bench/eightgent_harbor.py -> repo root is two levels up
    return Path(__file__).resolve().parents[2] / "dist" / "cli.js"


def split_model(model_name: str | None) -> tuple[str, str]:
    """`ollama/qwen3.5:9b` -> (`ollama`, `qwen3.5:9b`). Only local providers are accepted."""
    if not model_name or "/" not in model_name:
        raise ValueError("Model must be <provider>/<model>, e.g. ollama/qwen3.5:9b")
    provider, model = model_name.split("/", 1)
    if provider not in LOCAL_PROVIDERS:
        raise ValueError(
            f"Provider '{provider}' refused: this adapter is local-only "
            f"({', '.join(sorted(LOCAL_PROVIDERS))})."
        )
    return provider, model


def build_run_command(
    provider: str, model: str, instruction: str, max_turns: str | None
) -> str:
    parts = [
        BUN_BIN, BUNDLE_REMOTE, "run", "--yes",
        "--provider", provider,
        "--model", model,
        # Task files live outside the starting directory (/app, /etc, ...).
        "--no-workspace-boundary",
        "--output-format", "stream-json",
    ]
    if max_turns:
        parts += ["--max-turns", max_turns]
    parts.append(instruction)
    return " ".join(shlex.quote(p) for p in parts)


def build_env(provider: str, base_url: str | None) -> dict[str, str]:
    """Allowlist only. Nothing is inherited from the host environment."""
    var, default = LOCAL_PROVIDERS[provider]
    return {
        var: base_url or default,
        "HOME": "/root",
        "CI": "1",
    }


class EightGentCode(BaseInstalledAgent):
    @staticmethod
    @override
    def name() -> str:
        return "8gent-code"

    @override
    def get_version_command(self) -> str | None:
        return f"{BUN_BIN} {BUNDLE_REMOTE} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        provider, _ = split_model(self.model_name)  # fail before any work
        bundle = Path(os.environ.get("EIGHTGENT_TB_BUNDLE") or default_bundle())
        if not bundle.is_file():
            raise FileNotFoundError(
                f"8gent bundle not found at {bundle}. Run `bun run build` in 8gent-code first."
            )
        await self.ensure_system_dependencies(
            environment, ("curl", "unzip", "ca_certificates")
        )
        await self.exec_as_root(environment, command=f"mkdir -p {INSTALL_DIR}")
        await environment.upload_file(bundle, BUNDLE_REMOTE)
        # Bun is the only thing fetched from the network (the runtime, not the model).
        await self.exec_as_root(
            environment,
            command=(
                f"[ -x {BUN_BIN} ] || curl -fsSL https://bun.sh/install | bash; "
                f"{BUN_BIN} --version"
            ),
        )
        # Fail the setup, not the task, if the host model endpoint is unreachable.
        _, default = LOCAL_PROVIDERS[provider]
        base = os.environ.get("EIGHTGENT_TB_BASE_URL") or default
        probe = "/api/tags" if provider == "ollama" else "/v1/models"
        await self.exec_as_root(
            environment,
            command=f"curl -fsS -m 10 {shlex.quote(base + probe)} >/dev/null",
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        pass

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, model = split_model(self.model_name)
        env = build_env(provider, os.environ.get("EIGHTGENT_TB_BASE_URL"))
        cmd = build_run_command(
            provider, model, instruction, os.environ.get("EIGHTGENT_TB_MAX_TURNS")
        )
        await self.exec_as_agent(
            environment,
            command=f"{cmd} 2>&1 | tee {LOG_REMOTE}",
            env=env,
        )
