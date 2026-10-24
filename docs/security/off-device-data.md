# What leaves the device

8gent is free and local by default (Principle 2 in the repo's top-level guide). This page lists every path in the shipped code that can send a person's data to a machine that is not theirs, and says for each whether it runs by default or only after the person turns it on.

Audited 2026-10-24 on main at d96000c60, after 8gent v0.20.26 asked a person on an Android phone to enable voice input through a speech service that is often Google's cloud ("Why off device transcription?"). Issue: #4903.

The list lives in code, in one place: `scripts/local-first-sinks.ts`. The gate `scripts/local-first-gate.ts` reads it. This page is the human version; the gate fails when the two stop matching the source.

## The rule

- Nothing that sends user data off the device is on by default.
- Anything that can must name its destination in the words the person sees, and needs a yes (a key, a token, a login, a typed command).
- A default that breaks this is a known item: a linked issue and an expiry date, in the list, so it is never quiet.

User data here means audio, prompt text, tool results, files, images, keys, and anything derived from the person's work. A download that sends only an IP address and a client string is listed too, as `pull`.

## Default paths that still send user data

| Id | What leaves | Where | Why it is on | Status |
| --- | --- | --- | --- | --- |
| web-search | The search words the model writes | DuckDuckGo (`html.duckduckgo.com`) | `web_search` is in the default tool set and in the auto-allowed read-only set in `packages/permissions/permission-mode.ts`. The model can call it with no prompt to the person. | Known item, waiver #4912, expires 2026-11-07. Needs a decision: on by default, or behind a one-time yes that names DuckDuckGo. |

That one is the only entry the gate waives for user data. Run `bun scripts/local-first-gate.ts --no-waivers` to see it fail.

## Opt-in paths (user data can leave only after a yes)

| Id | What leaves | Where | The yes | Guard the gate checks |
| --- | --- | --- | --- | --- |
| cloud-transcription | Recorded speech | OpenAI transcription | `setMode("cloud")` and `OPENAI_API_KEY`; voice mode defaults to local whisper.cpp | `mode: "local"` in `packages/voice/types.ts`; key check in `packages/voice/cloud-transcriber.ts` |
| hosted-model-providers | Prompts, tool results, images | Anthropic, DeepSeek, Fireworks, Groq, MiniMax, Mistral, OpenAI, OpenRouter, Replicate, Together, xAI | An API key. Each provider is `enabled: false` until one is set; the OpenRouter client throws "nothing was sent to the hosted endpoint" without a key. Another company's command-line tool is a provider only with `PROVIDERS_ALLOW_HOST_CLI=1`. | Provider defaults and the client check in `packages/providers/index.ts` and `packages/eight/clients/openrouter.ts` |
| ollama-cloud | Prompts | ollama.com, through the person's own Ollama daemon, for model tags ending `-cloud` or `:cloud` | `EIGHT_OLLAMA_CLOUD=1` | See "Ollama cloud models" below |
| shared-judge-host | Risky shell commands | The judge model on `EIGHT_DECIDE_OLLAMA_HOST` (default this machine), or Vercel AI Gateway for the hosted evaluator | The environment variable; `AI_GATEWAY_API_KEY` for the evaluator | `packages/decide/backends/jev.ts` |
| 8gent-account | Sign-in and proxy traffic | 8gent.app, clerk.8gent.app, 8gentos.com, the model proxy | Signing in with `8gent auth login`. `8gent auth status` sends the proxy a GET to /health when signed in; `buildProxyProviderConfig` has no caller, so no model traffic goes to the proxy today. | File list in the sink entry |
| chat-and-mail-bridges | Messages and replies | Telegram, Slack, Discord, Resend | That service's token. The default Telegram hook ships `enabled: false`. | `packages/hooks/defaults.ts` |
| github-api | Issues, pull requests, searches | api.github.com | The person's GitHub token. The launch update check is `EIGHT_UPDATE_CHECK=1` only. | `packages/eight/update-notice.ts` |
| vercel-and-travel-apis | Deploy and travel-search requests | api.vercel.com, api.letsfg.co | The person's key; LetsFG throws "LETSFG_API_KEY is required" | `packages/travel/letsfg-provider.ts` |
| android-speech-service | Microphone audio, only if the person turns on the phone's speech service | The phone's speech recogniser through `termux-speech-to-text`; Android's SpeechRecognizer is often Google's service | The voice question is never asked on first launch, only after the person asks for voice; voice input is on-device whisper.cpp by default (#4910) | `packages/eight/android-setup.ts` (the question is reached only on the command) |
| db-convex | Records | A Convex deployment | A configured `CONVEX_URL`; without it the client logs "Running in offline mode" | `packages/db/client.ts` |
| scout-sources | Nothing of the person's: a GET request (no body, credentials or cookies) to each address they listed | Those addresses only, https, never this machine or a private network; the site sees an IP address and a client string | `8gent scout add` or `enable`, which lists every address and answers no on a bare Enter or with nobody to ask (CI, EIGHT_UNATTENDED, no terminal) | The consent hash in `packages/cron/routines.ts` and the internal-address check in `packages/cron/scout.ts` |
| flow-bridge | A page address web_fetch is asked to read, handed to the 8gent Flow app on the same Android phone (127.0.0.1 only); the Browser tab then loads that page, so the address reaches the page's own site as a direct web_fetch would, and nothing else | The Flow app on this phone | `8gent flow pair` on Android: one question, a bare Enter is No, unattended is No, and Flow shows its own Allow sheet (default Don't allow). With no pairing, or Flow not answering, web_fetch runs its normal path. | `ask(PAIR_QUESTION, false)` then `yes !== true` in `packages/tools/flow-bridge.ts` |

## Command paths (user data can leave only when the person types the command)

| Id | What leaves | Where | Command |
| --- | --- | --- | --- |
| threat-feed | Package names and versions from lockfiles | api.osv.dev, plus CISA and CIRCL feed reads | The threat-feed command. No other code calls it; the daemon only reads the reports a run leaves behind. |
| dj-radio-search | The station word typed into `/dj` | Radio Browser directory | `/dj` |
| fleet-internal | Model requests inside the fleet | `*.internal` private network names | Runs in fleet vessels. The names do not resolve from a person's machine. |

## Pulls and links (no user content)

- `pull`: bun.sh, deb.nodesource.com, nodejs.org (runtime installers), huggingface.co (whisper model weights), registry.npmjs.org (self-update, marketplace installs), raw.githubusercontent.com and github.com (update check when opted in, repository fetches), fonts.googleapis.com. The last one is also in the HTML a session export writes: the page asks Google Fonts for a font when the exported file is opened, so the viewer's address reaches Google. No session content does.
- `inert`: documentation links, XML namespaces, brand URLs. The code mentions them and never requests them.

## Reach with no hostname in the source

- `web_fetch` reads any URL the model chooses. A URL can carry text, so it can send. It goes through the network policy in `packages/permissions/policy-engine.ts` and the deny list in `go-deny-list.ts`. The gate cannot see these hosts because they are not in the source.
- `run_command` runs the person's own shell. A command that talks to the network is the person's command, under the run-command sandbox.
- OpenTelemetry in `packages/telemetry/otel.ts` makes trace and span ids only. It has no exporter and no endpoint.

## Ollama cloud models

Ollama 0.30 prints `OLLAMA_NO_CLOUD:false`: its cloud models are on unless the daemon is started with `OLLAMA_NO_CLOUD=1`. A model tagged `-cloud` or `:cloud` shows up in `/api/tags` next to the local ones with a size of a few hundred bytes, and a request to it is forwarded to ollama.com.

What 8gent did with that list before this change:

- `packages/eight/run.ts` `autoDetectOllamaModel` took the first model that was not an embedding, so a cloud tag could become the default for a headless run.
- `apps/tui/src/app.tsx` `detectBestLocalProvider` built the startup default from the same list.
- `packages/decide/probe.ts` `pickModel` sorts by size, smallest first, and a cloud tag is the smallest, so the judge that reads every risky command could pick it.
- `packages/eight/vision-router.ts` matched vision models by family name and labelled the match "local"; images could go to ollama.com.
- `packages/local-model-server/ollama.ts` `listModels`, which the onboarding probe, the task router and the local-model detector read, returned the cloud tags as installed models. So did `packages/providers/declared.ts` for a declared Ollama endpoint.
- `packages/ci/review.ts` and `packages/tools/image.ts` read the list too.

The fix is in two layers, both opt-in on `EIGHT_OLLAMA_CLOUD=1`:

1. `packages/core/ollama-cloud.ts` removes cloud tags from the lists every automatic choice reads (the shared `listModels`, the startup and headless defaults, the judge, vision, declared endpoints).
2. `OllamaClient` throws before it sends when the model is a cloud tag, with a line that says nothing was sent and how to change it.

Why not only `OLLAMA_NO_CLOUD=1`: 8gent does not start the daemon in the common case. The person starts Ollama (or the app does), and 8gent cannot set an environment variable on a process it did not launch. Passing the variable is right where 8gent does launch Ollama, and #4906 (background autostart) does: its launch sets `OLLAMA_NO_CLOUD=1`. The gate now fails any file that starts `ollama serve` without it.

Limit, stated plainly: a person who types `/model` with a cloud tag is refused by the client unless they set `EIGHT_OLLAMA_CLOUD=1`. That is a choice, so the refusal names the variable. The daemon the person runs themselves still has its own cloud setting; 8gent does not change it.

## What the gate does and does not do

It fails when:

1. a hostname appears in shipped code (`packages/`, `apps/tui/`, `bin/`) that no entry in `scripts/local-first-sinks.ts` covers;
2. a host or pattern with a `files` list is reached from a file outside it, which skips its guard;
3. an `optin` entry's guard no longer matches its file;
4. a `default` entry, or a failed guard, has no waiver, or the waiver has expired;
5. a file reads Ollama's `/api/tags` without using `packages/core/ollama-cloud.ts` and is not on the reviewed list;
6. a file starts `ollama serve` without `OLLAMA_NO_CLOUD`.

It reads text. A host assembled from pieces, a URL held in an environment variable, or reach through a dependency is not seen. It does not cover `scripts/`, the other apps, or the Convex backend, none of which ship in the npm package (`package.json` `files`): `apps/linkedin-vessel`, `apps/lil-eight`, `apps/video`, `scripts/` and the provisioning tools talk to LinkedIn, Crunchbase, Greenhouse, ElevenLabs, fal, Replicate, Clerk and Hetzner as the team's own services and tooling. The review question below covers them.

To add a sink, add one entry to `scripts/local-first-sinks.ts` in the same PR as the code, in the right mode, with a guard if user data can leave, and add its row here.

The same gate also enforces the second principle, one install and zero deps, described in `docs/security/principles-gate.md`.

## Review question

Every security review and every second read asks: **Does any default send user data off the device?** See `docs/security/review-checklist.md`.
