# Supply Chain Security Audit - 2026-03-25

Triggered by: Andrej Karpathy's report of litellm PyPI supply chain attack (exfiltrates SSH keys, AWS/GCP/Azure creds, Kubernetes configs, git credentials, env vars, API keys, shell history, crypto wallets, SSL private keys via malicious `pip install litellm`).

---

## 1. litellm Dependency Check

**Result: NOT USED. We are clean.**

- No `litellm` in any `package.json` (root or workspace packages)
- No `requirements.txt`, `Pipfile`, or `pyproject.toml` in the repo
- One Python file exists (`packages/kernel/train_lora.py`) - it imports only `unsloth`, `torch`, `transformers`, `peft`, `datasets` (all well-known ML packages). No litellm.
- Grep across entire repo: zero matches for "litellm"

## 2. Python Dependencies

We have no Python dependency management files. The single Python script (`train_lora.py`) uses:

| Package | Risk Level | Notes |
|---------|------------|-------|
| unsloth | Low | Popular LoRA training optimizer, GitHub-verified |
| torch | Low | PyTorch - Meta-maintained |
| transformers | Low | Hugging Face - widely audited |
| peft | Low | Hugging Face - LoRA adapter lib |
| datasets | Low | Hugging Face - data loading |
| bitsandbytes | Low | Quantization lib, well-known |

**None of these are installed via a lockfile** - they are optional runtime imports for the LoRA training script, which is off by default.

## 3. npm Dependencies That Interact with LLM APIs

Root `package.json`:

| Package | Purpose | Risk Notes |
|---------|---------|------------|
| `ai` (Vercel AI SDK) | Core LLM interaction | Well-maintained, Vercel-backed, no install scripts |
| `@ai-sdk/openai-compatible` | OpenRouter/Ollama provider | Part of Vercel AI SDK ecosystem |

These are our only two LLM-adjacent npm dependencies. Both are maintained by Vercel, widely used, and do not run install-time scripts.

Other notable dependencies (not LLM-specific but network-capable):

| Package | Purpose | Install Scripts |
|---------|---------|-----------------|
| `better-sqlite3` | Local DB | Has native build (node-gyp), but well-known |
| `sharp` | Image processing | Has native build, pre-built binaries from GitHub |
| `@napi-rs/canvas` | Canvas rendering | Native addon, napi-rs ecosystem |
| `miniflare` | Cloudflare Workers dev | Cloudflare-maintained |
| `stripe` | Payments | Stripe-maintained |
| `tree-sitter` + parsers | AST parsing | Native builds, well-known |

## 4. Security Hook Analysis

### Does our security-validator hook catch this kind of attack?

**Partially.** The hook at `~/.claude/hooks/security-validator.ts` blocks:

- curl/wget pipe-to-shell (`curl ... | bash`) - **YES, this would catch a malicious install script**
- Reverse shells - YES
- Data exfiltration via curl upload or tar-pipe - YES
- Base64 decode to shell - YES

**Gaps the hook does NOT cover:**

- `pip install <malicious-package>` - NOT BLOCKED (pip is not flagged)
- `npm install <malicious-package>` - NOT BLOCKED (postinstall scripts run silently)
- `npx <malicious-package>` - NOT BLOCKED
- Bun's `postinstall` scripts - NOT BLOCKED
- A compromised npm package reading `~/.ssh/` or `~/.aws/` during install - NOT DETECTED

### Existing security-scanner.ts

`packages/validation/security-scanner.ts` scans source files for leaked secrets and vulnerability patterns. It does NOT scan dependencies or detect supply chain risks.

## 5. Recommended Security Hardening Steps

### NOW (immediate)

1. **Add `pip install` and `npx` to the security-validator hook** - at minimum log these operations
2. **Run `bun audit`** periodically (or add to CI) - checks known CVEs in npm deps
3. **Pin exact versions** in package.json (remove `^` prefixes) for critical deps like `ai`, `@ai-sdk/openai-compatible`
4. **Add the dep-scanner** (`packages/validation/dep-scanner.ts`) to pre-commit or CI

### NEXT (this week)

5. **Add `--ignore-scripts` to bun install in CI** - prevents postinstall attacks
6. **Review `postinstall` script in our own package.json** - it runs `npx bmad-method init` which executes arbitrary code from a third-party package at install time
7. **Create a lockfile audit script** that diffs `bun.lockb` changes in PRs

### LATER (ongoing)

8. **Consider Socket.dev or Snyk** for automated supply chain monitoring
9. **Isolate the Python training script** - run in a container or venv with pinned deps
10. **Network policy for install** - if running in CI, block outbound except known registries

## 6. Overall Risk Assessment

**Low risk currently.** We have a small dependency surface, no Python package manager files, and our LLM deps are from Vercel (well-audited). The litellm attack does not affect us.

The main gap is that our security hook does not monitor package manager install commands, and our `postinstall` script runs `npx bmad-method init` which is a vector if that package were compromised.
