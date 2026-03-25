"""
8gent Code - Harbor Framework Adapter

Runs 8gent's agent loop inside Harbor's Docker environments for
Terminal-Bench, SWE-bench, and other benchmark datasets.

Usage:
    PYTHONPATH=. harbor run -d terminal-bench-sample@2.0 \
        --agent-import-path benchmarks.harbor_adapter.eight_agent:EightAgent \
        -o benchmarks/harbor-results -y

The adapter installs Bun + 8gent-code from npm inside the container,
then pipes the task instruction through `8gent chat --yes`.
"""

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class EightAgent(BaseAgent):
    """Harbor adapter for 8gent Code agent."""

    @staticmethod
    def name() -> str:
        return "8gent"

    def version(self) -> str | None:
        return "2.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Install Bun and 8gent-code in the Docker environment."""

        # Install system dependencies that 8gent needs
        await environment.exec(
            command=(
                "apt-get update -qq && "
                "apt-get install -y -qq curl unzip git ca-certificates > /dev/null 2>&1"
            ),
            user="root",
            timeout_sec=120,
        )

        # Install Bun
        result = await environment.exec(
            command="curl -fsSL https://bun.sh/install | bash",
            user="root",
            timeout_sec=60,
        )

        # Make bun available globally
        await environment.exec(
            command=(
                "ln -sf /root/.bun/bin/bun /usr/local/bin/bun && "
                "ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx"
            ),
            user="root",
        )

        # Install 8gent-code globally from npm
        await environment.exec(
            command="bun install -g @podjamz/8gent-code",
            user="root",
            timeout_sec=120,
        )

        # Symlink the binary to a global path
        await environment.exec(
            command=(
                "ln -sf /root/.bun/install/global/node_modules/.bin/8gent /usr/local/bin/8gent || "
                "ln -sf $(find /root/.bun -name '8gent' -type f 2>/dev/null | head -1) /usr/local/bin/8gent || "
                "true"
            ),
            user="root",
        )

        # Verify installation
        result = await environment.exec(
            command="which 8gent && 8gent --version 2>/dev/null || echo '8gent not found in PATH'",
            user="root",
        )
        version_out = result.stdout.strip() if result.stdout else "unknown"
        self.logger.info(f"8gent setup complete: {version_out}")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run 8gent's agent against the task instruction.

        The agent executes shell commands autonomously to complete the task.
        AgentContext is a pydantic data model for token/cost tracking only.
        """

        # Escape single quotes in instruction for shell
        escaped = instruction.replace("'", "'\\''")

        # Determine model config from self.model_name
        env_vars = {
            "PATH": "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin",
            "BUN_INSTALL": "/root/.bun",
            "HOME": "/root",
            "DEBIAN_FRONTEND": "noninteractive",
        }

        if self.model_name:
            if "/" in self.model_name:
                provider, model = self.model_name.split("/", 1)
                env_vars["EIGHT_PROVIDER"] = provider
                env_vars["EIGHT_MODEL"] = model
            else:
                env_vars["EIGHT_MODEL"] = self.model_name

        # Run 8gent in non-interactive chat mode
        # --yes auto-approves all tool calls (benchmark mode)
        result = await environment.exec(
            command=f"8gent chat '{escaped}' --yes 2>&1 || echo '[8gent exited with error]'",
            env=env_vars,
            timeout_sec=300,
        )

        # Log output for debugging
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        self.logger.info(
            f"8gent completed (exit {result.return_code}), "
            f"stdout: {len(stdout)} chars, stderr: {len(stderr)} chars"
        )

        if stdout:
            self.logger.debug(f"stdout (last 2000): {stdout[-2000:]}")
        if stderr:
            self.logger.debug(f"stderr (last 1000): {stderr[-1000:]}")
