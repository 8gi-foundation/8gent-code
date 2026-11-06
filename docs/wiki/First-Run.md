# First Run

Run `8gent` in a project folder. This page describes what happens, in order, and where each step lives in the code so you can verify it.

## 1. Startup

- The splash shows "8gent is starting, checking local models" at once (`apps/tui/src/components/IntroBanner.tsx`, `INTRO_STARTING_LINE`).
- Startup writes a boot trace to `~/.8gent/logs/tui-boot.log`. It does not record prompt text. Turn it off with `EIGHT_BOOT_TRACE=0` (`bin/8gent-run.js`).
- Env files are loaded before detection (`loadEnvFile` in `apps/tui/src/app.tsx`). A project `.env` only contributes provider key variables; `~/.8gent/.env` is read in full.

## 2. Which model is picked

Source: `loadProviderSettings`, `detectBestLocalProvider` in `apps/tui/src/app.tsx`.

**If you already saved a model**, no detection runs. The saved provider and model come from `~/.8gent/providers.json` (`activeProvider`, `activeModel`). The same applies when the saved provider is a hosted one whose key is present.

**Otherwise** local servers are asked at the same time, each bounded at 2 seconds, and the first one with a chat model wins, in this order:

1. llama-server, only when you selected it (`isLlamaServerSelected`, `packages/local-model-server/select.ts`). When selected, Ollama is switched off and its slot probes llama-server instead.
2. LM Studio at `LM_STUDIO_HOST`, default `http://localhost:1234` (`/v1/models`).
3. Ollama at `OLLAMA_BASE_URL`, then `OLLAMA_HOST`, then localhost (`/api/tags`; resolution in `packages/local-model-server/ollama-host.ts`). Ollama cloud-tagged models are never chosen as the startup default.
4. apfel (Apple Foundation Model), only on macOS with Apple Silicon, at `http://localhost:11435`.

Embedding-only models are skipped. Among several chat models, `pickBestChatModel` in `apps/tui/src/lib/model-selection.ts` chooses by a score.

**If no local server has a chat model:**

5. Exactly one hosted provider with a key in your environment: that provider is used, and its model is read from its live list once the TUI is up.
6. Otherwise: `openrouter` with model `auto:free`, the free tier.

`--provider` and `--model` flags override the saved values (`computeCliOverrides`). With `--provider` and no model, the model comes from that provider's live list, never from a model saved for a different provider.

Change it any time with `/model` and `/provider`. See [Providers and Models](Providers-and-Models) and [Commands](Commands).

## 3. First-run setup chat

Shown while `onboardingComplete` is false in `~/.8gent/user.json` (`needsOnboarding` in `packages/self-autonomy/onboarding.ts`). `--yes` or `-y` skips it.

Detection runs in the background while the setup is already on screen (`OnboardingManager.detect`):

- Git name and email, GitHub login (`gh auth status`) and your Ollama models, read from your own machine.
- A bounded Ollama check (2.5 s, `OLLAMA_PROBE_TIMEOUT_MS`).
- Other servers on loopback only, 1.5 s each (`packages/self-autonomy/local-servers.ts`): llama-server (needs both `/health` and `/v1/models`), LM Studio, and apfel on Apple Silicon.

Servers found are listed in this order: LM Studio, Ollama, llama-server, apfel. If llama-server is selected it goes first. A server with no chat model is not offered.

Steps in order (`ONBOARDING_QUESTIONS`): welcome, identity, role, projects, communication, provider checks (Ollama, LM Studio, apfel), provider choice, provider key (asked only if you picked a hosted provider with no key; input is masked and saved to your keys file), display names for the assistants, voice, confirmation. Provider choice offers the servers found, a free cloud option, and "decide later". With nothing found it points to the install guide for your OS.

Your answers are saved to `~/.8gent/user.json`.

## If nothing answers

You land on the free OpenRouter tier or a hosted provider you keyed, or the model call fails. Start a local server and pull a model, for example Ollama then `ollama pull qwen3.5` (from [../user/install.md](../user/install.md)), then run `8gent doctor`. Per-platform steps: [../install/macos.md](../install/macos.md), [../install/linux.md](../install/linux.md), [../install/windows.md](../install/windows.md).

## Files first run may create

`~/.8gent/user.json` (setup answers), `~/.8gent/providers.json` (saved provider and model), `~/.8gent/logs/tui-boot.log` (boot trace), `~/.8gent/keys.env` (only if you add a key).

Next: [Providers and Models](Providers-and-Models), [Permission Modes](Permission-Modes), [Configuration](Configuration).
