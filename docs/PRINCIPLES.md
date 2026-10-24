# Principles and primitives

The 8 principles we build by, and the engineering rules that follow from them. One page. If a change breaks one of these, it is a fix first.

## The 8 principles

Verbatim from the repo root instruction file, section "First Principles". Principle 6 uses "sub-8gents" where the source has an older spelling.

1. **Design first, not last.** Before writing code, think about the interaction. Friction is the enemy. The best interface is the minimum that serves the user.
2. **Free and local by default.** No API keys to start. Local models first. Cloud is opt-in. Privacy is the foundation.
3. **Self-evolving.** Eight gets better every session. Lessons persist. Skills accumulate.
4. **Hyper-personal.** Learn the user's patterns, preferences, codebase, style. Two users should have different experiences after a week.
5. **Accessible.** Key docs have audio. Voice input works. Screen readers work. Adapt to the user, not the reverse.
6. **Orchestrate by default.** Delegate to sub-8gents. Decompose complexity. Use worktrees.
7. **Reduce friction, increase truth.** Prefer voice and conversation over forms.
8. **The work speaks for itself.** Expertise is process, design, communication, and what ships - not credentials or enthusiasm.

## Engineering primitives

Each rule says what we do and its status on main. A rule marked as landing is a goal with an open issue or PR, not yet true.

1. **Local by default.** No user data leaves the device on a default path. Cloud is an explicit opt-in that names where the data goes. Status: partly true. The gate is merged (#4913); Termux voice now transcribes on the phone (#4905, merged in #4910). Not yet true: `web_search` still sends the model's query to DuckDuckGo on a default path (#4912, waiver to 2026-11-07).
2. **One install, zero deps.** Core works after one install of 8gent, with no system packages. We build and pin our own binaries; Ollama, system installs and cloud are fallbacks or extensions. Status: partly true. CI now builds our own `llama-server` and `whisper-cli` for five targets (#4916, merged). Landing: 8gent using its own pinned `llama-server` (#4909). Not yet true: some default paths still run or ask for a system install (#4915, waivers to 2026-11-07).
3. **llama.cpp is the local runtime.** The local judge and phone runtime are `llama-server` on 127.0.0.1; Ollama is only a fallback. Status: landing: #4909 (open).
4. **A deterministic tool before a model.** Ask whether code can do the step with no model before patching a prompt. Status: working practice, no CI check.
5. **Nothing goes straight to the model.** Every input passes one deterministic gate (commands, sanitizer, policy) first. Status: enforced on the daemon path by `packages/daemon/input-gate.ts`, with `packages/daemon/agent-pool-gate.test.ts` asserting the gate runs before the model call. Other surfaces are reviewed by hand, not by CI.
6. **Install prompts default to No.** Asking is allowed; assuming yes is not. Status: the Termux voice question answers No on a bare Enter (#4910, merged); the local judge prompt lands with #4909.
7. **No one at the keys means no.** With nobody to answer, nothing installs and nothing is sent. Status: landing: #4919 (open).
8. **Fail closed, with a reason.** When a check cannot pass, stop and say why in plain words. Status: merged for the permissions read rule and its Landlock helper (#4921); other paths are reviewed by hand.
9. **Prohibitions hold everywhere.** No em dashes, no secrets in chat, no stat padding, no enthusiasm inflation, no direct push to main. Source: the repo root instruction file, section "Absolute Prohibitions".

## Where it is enforced

Rules 1 and 2 are checked by CI: see the [principles gate](security/principles-gate.md) (`scripts/local-first-gate.ts`). A new off-device path or a new install step on a default path fails the build. The gate does not yet make the rules fully true: known items pass only on waivers that expire 2026-11-07, listed with their reasons in [off-device-data.md](security/off-device-data.md) (#4912, #4915).
