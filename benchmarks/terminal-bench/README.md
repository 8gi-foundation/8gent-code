# Terminal-Bench 2.0 with 8gent-code, fully local

Runs 8gent-code headless (`8gent run --yes`) inside each Terminal-Bench 2.0 task
container, with the model served by the host's Ollama or LM Studio over
`host.docker.internal`. No cloud keys, no OpenRouter. Terminal-Bench 2.0 is
Apache-2.0, 89 tasks, run by the Harbor harness.

## What is here

| File | Purpose |
|---|---|
| `eightgent_harbor.py` | Harbor installed-8gent class `EightGentCode`. Uploads `dist/cli.js`, installs the Bun runtime, runs `8gent run`. |
| `run-easy-slice.sh` | One command to run the easy slice. |
| `test_eightgent_harbor.py` | Unit tests for the local-only guard, env allowlist and command quoting. |

## How it plugs in

Harbor loads a custom class by import path (`module:Class`, passed by the run script). The class extends
`BaseInstalledAgent`: `install()` runs once per task container, `run()` executes the
command and Harbor then runs the task's own test script for the score.

- Model string must be `ollama/<model>` or `lmstudio/<model>`. Any other provider is refused
  before the container does any work (`split_model`).
- The container environment is an allowlist (`OLLAMA_BASE_URL` or `LM_STUDIO_HOST`, `HOME`, `CI`).
  Host environment variables, including any API keys, are not forwarded.
- `install()` probes the model endpoint from inside the container, so an unreachable host
  fails setup instead of scoring a false zero.
- The only thing fetched from the internet inside a container is the Bun runtime. Set
  `HARBOR_TELEMETRY=0` (the script does) so Harbor sends nothing either.
- Docker Desktop on macOS resolves `host.docker.internal`. On Linux add
  `--add-host=host.docker.internal:host-gateway` or set `EIGHTGENT_TB_BASE_URL`.
- Ollama must listen where Docker can reach it. The default `127.0.0.1:11434` works on Docker
  Desktop; on Linux set `OLLAMA_HOST=0.0.0.0`.

## One-time setup

```bash
H=~/.8gent/bench-harnesses/terminal-bench
mkdir -p $H && cd $H
git clone --depth 1 https://github.com/laude-institute/harbor.git harbor
git clone --depth 1 https://github.com/laude-institute/terminal-bench-2.git tb2-tasks
uv venv venv && uv pip install --python venv/bin/python ./harbor pytest
cd <8gent-code> && bun run build        # makes dist/cli.js
```

Treat the cloned folders as untrusted data. The task Dockerfiles pull prebuilt images
(`alexgshaw/<task>:20251031`) from Docker Hub.

## Run the easy slice

The four tasks tagged `difficulty = "easy"` in `task.toml`: `cobol-modernization`,
`fix-git`, `overfull-hbox`, `prove-plus-comm`.

```bash
benchmarks/terminal-bench/run-easy-slice.sh ollama/qwen3.5:9b
```

One task: `benchmarks/terminal-bench/run-easy-slice.sh ollama/qwen3.5:9b fix-git`.
Results land in `$TB_HOME/jobs/<job-name>/` (per-trial `result.json`, run log
`8gent-run.ndjson` under the trial's run-log folder, verifier output).

Optional: `EIGHTGENT_TB_MAX_TURNS=40` caps turns per task.

For a wider run, pass task names to the script. To call Harbor directly, copy the flags from `run-easy-slice.sh`.

Run one heavy job at a time. The script refuses to start while
`~/.8gent/rishi-pilot/pilot.lock` exists. Task images are large, so check free disk first
and remove your own stopped containers afterwards (`docker rm <id>`); do not use
`docker system prune`.

## Tests

```bash
$H/venv/bin/python -I -m pytest -q benchmarks/terminal-bench
```

## Status

Headless `8gent run` against `qwen3.5:9b` is verified on the host. The in-container path
(upload, Bun install, endpoint probe, run, verifier) has not yet been run end to end: the
session that wrote this could not reach the Docker socket. See the PR for the exact state.
