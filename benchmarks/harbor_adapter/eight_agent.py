"""
8gent Code - Harbor Framework Adapter

Runs 8gent inside Harbor's Docker environments for Terminal-Bench 2.1,
DeepSWE and other Harbor datasets. See benchmarks/TERMINAL-BENCH.md.

    EIGHT_VERSION=0.20.43 BUN_VERSION=1.2.3 PYTHONPATH=. harbor run -d terminal-bench-sample@2.1 \
        --agent-import-path benchmarks.harbor_adapter.eight_agent:EightAgent \
        -m <model> -o benchmarks/harbor-results

Command building lives in commands.py (no Harbor import, unit tested).
"""

import os

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from . import commands as cmd


class EightAgent(BaseAgent):
    """Harbor adapter for 8gent Code."""

    def __init__(self, *args, eight_version: str | None = None, bun_version: str | None = None, task_timeout_sec: int | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._version = cmd.pinned_version(os.environ, eight_version)
        self._bun_version = cmd.pinned_bun_version(os.environ, bun_version)
        self._timeout = cmd.task_timeout(os.environ, task_timeout_sec)

    @staticmethod
    def name() -> str:
        return "8gent"

    def version(self) -> str | None:
        return self._version

    async def setup(self, environment: BaseEnvironment) -> None:
        """Install the pinned release. A prebuilt image that has it skips the fetch."""
        probe = await environment.exec(command="command -v bun >/dev/null && command -v 8gent >/dev/null && echo ok", user="root")
        if not (probe.stdout or "").strip() == "ok":
            await environment.exec(
                command="apt-get update -qq && apt-get install -y -qq curl unzip git ca-certificates > /dev/null 2>&1",
                user="root",
                timeout_sec=300,
            )
            await environment.exec(command=cmd.bun_install_command(self._bun_version), user="root", timeout_sec=120)
            await environment.exec(
                command="ln -sf /root/.bun/bin/bun /usr/local/bin/bun && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx",
                user="root",
            )
        await environment.exec(command=cmd.install_command(self._version), user="root", timeout_sec=300)
        await environment.exec(
            command="ln -sf /root/.bun/install/global/node_modules/.bin/8gent /usr/local/bin/8gent || true",
            user="root",
        )
        result = await environment.exec(command="8gent --version", user="root")
        self.logger.info(f"8gent pinned {self._version}, reports: {(result.stdout or '').strip()}")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        model = cmd.resolve_model(self.model_name, os.environ)
        setup = cmd.provider_setup_command(os.environ, model)
        if setup:
            await environment.exec(command=setup, user="root")

        result = await environment.exec(
            command=cmd.run_command(instruction, os.environ, model),
            env=cmd.run_env(os.environ, model),
            timeout_sec=self._timeout,
        )
        stdout = result.stdout or ""
        summary = cmd.parse_events(stdout)
        context.n_input_tokens = summary["n_input_tokens"]
        context.n_output_tokens = summary["n_output_tokens"]
        if summary["cost_usd"] is not None:
            context.cost_usd = summary["cost_usd"]
        meta = dict(getattr(context, "metadata", None) or {})
        meta.update(
            eight_version=self._version,
            trajectory_path=summary["trajectory_path"],
            result=summary["result"],
            exit_code=result.return_code,
        )
        try:
            context.metadata = meta
        except Exception:
            pass
        self.logger.info(
            f"8gent exit {result.return_code}, in={summary['n_input_tokens']} "
            f"out={summary['n_output_tokens']} log={summary['trajectory_path']}"
        )
