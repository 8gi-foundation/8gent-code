"""
8gent Code - Harbor Framework Adapter

Runs 8gent's agent loop inside Harbor's Docker environments for
Terminal-Bench, SWE-bench, and other benchmark datasets.

Usage:
    harbor run -d terminal-bench-sample@2.0 \
        --agent-import-path benchmarks/harbor-adapter/eight_agent.py:EightAgent \
        -m ollama/qwen3.5 \
        -o benchmarks/harbor-results

The adapter installs Bun + 8gent-code from npm inside the container,
then runs the agent in headless CLI mode against the task instruction.
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
        # Install Bun
        await environment.exec(
            command="curl -fsSL https://bun.sh/install | bash",
            user="root",
        )

        # Add bun to PATH for all users
        await environment.exec(
            command='echo "export BUN_INSTALL=/root/.bun" >> /etc/profile && '
                    'echo "export PATH=/root/.bun/bin:$PATH" >> /etc/profile',
            user="root",
        )

        # Install 8gent-code from npm
        await environment.exec(
            command="/root/.bun/bin/bun install -g @podjamz/8gent-code",
            user="root",
        )

        # Install Ollama for local model support (if not using cloud)
        if self.model_name and "ollama" in (self.model_name or "").lower():
            await environment.exec(
                command="curl -fsSL https://ollama.com/install.sh | sh",
                user="root",
            )
            # Pull the model
            model = self.model_name.split("/", 1)[-1] if "/" in self.model_name else "qwen3.5"
            await environment.exec(
                command=f"ollama serve &>/dev/null & sleep 3 && ollama pull {model}",
                user="root",
                timeout_sec=300,
            )

        self.logger.info("8gent setup complete")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run 8gent's agent against the task instruction."""
        # Determine the model to use
        model = "qwen3.5"  # default local
        env_vars = {
            "PATH": "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin",
            "BUN_INSTALL": "/root/.bun",
        }

        if self.model_name:
            if "ollama" in self.model_name.lower():
                model = self.model_name.split("/", 1)[-1] if "/" in self.model_name else "qwen3.5"
                env_vars["EIGHT_PROVIDER"] = "ollama"
                env_vars["EIGHT_MODEL"] = model
            elif "openrouter" in self.model_name.lower():
                model = self.model_name.split("/", 1)[-1] if "/" in self.model_name else model
                env_vars["EIGHT_PROVIDER"] = "openrouter"
                env_vars["EIGHT_MODEL"] = model
            else:
                # Assume provider/model format
                parts = self.model_name.split("/", 1)
                if len(parts) == 2:
                    env_vars["EIGHT_PROVIDER"] = parts[0]
                    env_vars["EIGHT_MODEL"] = parts[1]

        # Escape the instruction for shell
        escaped_instruction = instruction.replace("'", "'\\''")

        # Run 8gent in non-interactive chat mode with auto-approval
        # The agent processes the instruction and executes tools autonomously
        result = await environment.exec(
            command=(
                f"export PATH=/root/.bun/bin:$PATH && "
                f"export BUN_INSTALL=/root/.bun && "
                f"8gent chat '{escaped_instruction}' --yes --json"
            ),
            env=env_vars,
            timeout_sec=600,  # 10 minute timeout per task
        )

        # Capture output for context
        if result.stdout:
            context.add_message(
                role="assistant",
                content=result.stdout[-5000:] if len(result.stdout) > 5000 else result.stdout,
            )

        if result.return_code != 0 and result.stderr:
            context.add_message(
                role="system",
                content=f"Agent exited with code {result.return_code}: {result.stderr[-2000:]}",
            )

        self.logger.info(
            f"8gent completed with exit code {result.return_code}",
            extra={
                "stdout_len": len(result.stdout) if result.stdout else 0,
                "stderr_len": len(result.stderr) if result.stderr else 0,
            },
        )
