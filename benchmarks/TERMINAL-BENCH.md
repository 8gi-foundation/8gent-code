# Terminal-Bench Integration

8gent Code runs on [Terminal-Bench 2.1](https://tbench.ai) through the [Harbor Framework](https://harborframework.com), using the adapter in `benchmarks/harbor_adapter/`. The target is the Harness Leaderboard (huggingface.co/spaces/joelniklaus/harness-leaderboard): 3 attempts per task, open models.

## Adapter

| File | Role |
|------|------|
| `benchmarks/harbor_adapter/eight_agent.py` | Harbor class `EightAgent` (setup, run, result reporting) |
| `benchmarks/harbor_adapter/commands.py` | Command building and event parsing. No Harbor import, no network |
| `benchmarks/harbor_adapter/test_commands.py` | Unit tests for the above |

Run the tests (no network, no Harbor needed):
```bash
python3 -m unittest benchmarks.harbor_adapter.test_commands
```

### Configuration

| Variable | Meaning |
|----------|---------|
| `EIGHT_VERSION` | Required. Released version to install, for example `0.20.43`. `latest` and ranges are refused. Also accepted as `eight_version=` |
| `BUN_VERSION` | Required. Bun release the installer fetches, for example `1.2.3`, passed as `bash -s bun-v$BUN_VERSION`. `latest` and ranges are refused. Also accepted as `bun_version=` |
| `EIGHT_HARBOR_MODEL` | Model id sent to the endpoint. Falls back to Harbor's `-m` |
| `EIGHT_HARBOR_BASE_URL` | OpenAI-compatible endpoint (for example `https://host/v1`). Written to `~/.8gent/providers.json` inside the trial as provider `harbor-endpoint` |
| `EIGHT_HARBOR_API_KEY_ENV` | Name of the variable that holds the key (default `OPENAI_API_KEY`). Only that one variable is passed into the trial |
| `EIGHT_TASK_TIMEOUT_SEC` | Per-task limit in seconds. Unset means Harbor applies each task's own timeout from its `task.toml`. Also `task_timeout_sec=` |
| `EIGHT_HARBOR_YES_FLAG` | `1` adds `--yes` for builds that predate `EIGHT_HEADLESS_APPROVE`. Off by default |

### Version pin

Setup installs exactly `@8gi-foundation/8gent-code@$EIGHT_VERSION`. If the image already has Bun and that version, nothing is fetched at trial time, so a prebuilt image with the release baked in runs with no install step. Bun is pinned the same way through `BUN_VERSION`. Record both pins next to any submitted result. The system packages installed with apt (curl, unzip, git, ca-certificates) follow the image distro and are not pinned; a prebuilt image avoids them.

### Approval

Nothing is hardcoded to `--yes`. Each run sets `EIGHT_HEADLESS_APPROVE=1` for that process only, the explicit opt-in introduced in PR #39 (open at time of writing). Current main does not read it and runs `-p` without prompting, so the adapter works on both. Unattended runs are the benchmark's explicit choice, not a default of 8gent. The done gate is switched off (`EIGHT_DONE_GATE=0`) because the benchmark grades the result itself.

### What Harbor collects

Each trial runs `8gent -p --mode json --no-session`. The event stream is kept at `/logs/agent/8gent-events.jsonl` (stderr in `8gent-stderr.log`), which Harbor copies to the trial's log folder. The result carries input and output token totals summed from the stream, `cost_usd` only when the stream reports one (otherwise left unset), and metadata with the version, exit code, outcome and trajectory path.

## Setup

```bash
uv tool install harbor
harbor --version
harbor datasets list
```

## Oracle sample (free, no model)

```bash
harbor run -d terminal-bench-sample@2.1 -a oracle -o benchmarks/harbor-results
```
Use `terminal-bench-sample@2.0` if `harbor datasets list` does not show a 2.1 sample. It needs Docker.

## 10-task smoke with a model

```bash
export EIGHT_VERSION=0.20.43
export BUN_VERSION=1.2.3
export EIGHT_HARBOR_BASE_URL=https://your-endpoint/v1
export EIGHT_HARBOR_API_KEY_ENV=MY_ENDPOINT_KEY   # the key itself stays in your shell
export EIGHT_HARBOR_MODEL=<model id on that endpoint>
PYTHONPATH=. harbor run -d terminal-bench-sample@2.1 \
  --agent-import-path benchmarks.harbor_adapter.eight_agent:EightAgent \
  -o benchmarks/harbor-results
```
The leaderboard models (GLM-5.3-Flash, DeepSeek-V4.1-Flash, Flint) go through the same variables by changing `EIGHT_HARBOR_MODEL` and the endpoint. Pointing at a hosted endpoint sends task text off the device; that is your opt-in and is not the default.

Full run with 3 attempts per task: use `-d terminal-bench@2.1` and Harbor's attempts option (`harbor run --help` for the current flag name).

## DeepSWE

TODO. Not verified, so no command is given:
- Confirm whether Harbor ships a DeepSWE dataset (`harbor datasets list`). If it does, the same adapter command works with `-d <that dataset>`.
- If it does not, the dataset adapter and its grader are missing.
- Check that its tasks fit the adapter's assumptions: a Linux container with network to the model endpoint and write access to `/logs/agent`.

## Results

Stored in `benchmarks/harbor-results/`. View with `harbor view benchmarks/harbor-results`.

## Status

Not yet run end to end: the oracle sample was not run in the authoring sandbox (no Docker). Adapter field names on Harbor's result object follow Harbor's published model and have not been exercised against a live install.
