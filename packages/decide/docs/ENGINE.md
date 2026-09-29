# Eight System One - Engine Mirror Board Report

Chair: 8TO (engine mirror board). Date: 2026-09-28. Host: Apple M2 Max, 96 GB, macOS, Bun 1.3.14, Ollama 0.34.2.
PRD: forge 8gi-ops #14. All numbers below come from the sub-officer result JSON. Each lane's commands are listed next to its numbers. No number here was estimated by the chair.

Conditions that affect every number: the machine was under heavy contention during the spike. The load average reached 392, trustd ran at about 95% CPU, llama3.2:3b sat resident in Ollama, and several Chrome processes were running. The data volume also fell to 105-350 MB free (186-257 MiB in other lanes), which is how one lane failed. Treat every latency here as an upper bound.

---

## 1. Results by lane

### Lane A - In-process llama.cpp from Bun (node-llama-cpp) - WORKED

| What | Measured | Command |
|---|---|---|
| Install under Bun | node-llama-cpp 3.22.1, 111 packages in 8.84 s, 1 postinstall blocked by Bun, prebuilt `@node-llama-cpp/mac-arm64-metal` used (gpu=metal, buildType=prebuilt) | `bun add node-llama-cpp; bun t_bind.ts` |
| Model source | MiniCPM5-1B Q8_0 GGUF read directly from the Ollama blob `sha256-0dc76385...`, 1,153,529,216 bytes, Ollama not involved | `cat ~/.ollama/models/manifests/hf.co/openbmb/MiniCPM5-1B-GGUF/Q8_0; ls -la ~/.ollama/models/blobs/sha256-0dc76385...` |
| Warm load (bindings / model / context) | 336.4 ms / 1708.3 ms / 496.5 ms; whole process 5.73 s wall for 4 questions x 5 runs | `time NOTHINK=0 bun decide.ts "" 5` |
| Cold first-run bindings load | 248,884 ms first run, 106,388 ms second, 66,931 ms in an isolated getLlama test; only 0.45 s user CPU | `bun decide.ts; time bun t_bind.ts; uptime; ps -Ao pcpu,pmem,comm -r` |
| Per-decision p50, warm, lower load | 68.7 / 54 / 117 / 94.1 ms | `NOTHINK=0 bun decide.ts "" 5` |
| Per-decision p50, heavy contention, 20 runs | 154.4 / 126.6 / 185.9 / 227.5 ms (p90 405 / 373 / 358 / 285) | `bun decide.ts` |
| Determinism within a process | identicalAcrossRuns=true, distinctOutputs=1, 4 questions x 20 runs | `bun decide.ts` |
| Determinism across processes | pYes identical to 6 decimals: 0.39875, 0.382411, 0.77501, 0.489923 | `bun decide.ts` vs `NOTHINK=0 bun decide.ts "" 5` |
| Answer quality, raw prompt | README is docs 0.399 (Yes/No share 0.37); Paris is capital of Germany 0.382 (0.32); confirm before deleting home dir 0.775 (0.24); 17 is prime 0.490 (0.36); top token `<think>` every time | `bun decide.ts` |
| Answer quality, empty `<think></think>` prefill | pYes 0.451 / 0.323 / 0.465 / 0.421; share 0.113 / 0.347 / 0.052 / 0.315 (worse) | `bun decide.ts` (default NOTHINK prefill) |

Method: `sequence.controlledEvaluate` with `generateNext.logits` filtered to 5 Yes and 5 No spellings, plus `totalLogitWeight`. p(yes) is a softmax over the answer tokens. `answerMassCoverage` is the share of full-vocabulary probability that lands on those answer tokens. Nothing is sampled.

Verdict: the in-process runtime is solved and deterministic. This 1B model, prompted this way, is not a usable decision scorer.

### Lane B - ONNX Runtime under Bun - WORKED

Model: Xenova/distilbert-base-uncased-finetuned-sst-2-english, `onnx/model_int8.onnx`, 67,370,466 bytes, Apache-2.0. Its sha256 (0daddfc1...) matches the HF LFS oid. The tokenizer is a from-scratch TS WordPiece and has not been checked against the reference tokenizer.

| What | Measured | Command |
|---|---|---|
| Loads under Bun; EPs reported | cpu, webgpu, coreml; common=1.30.0 node=1.30.0 | `cd /Users/jamesspalding/wt/engine-spike/onnx && bun load.ts` |
| First-ever require (cold, disk under pressure) | 18,992.0 ms; later warm requires 40-89 ms | `bun load.ts ; bun run.ts cpu` |
| CPU EP session create, 1 thread | 262.7 ms (264-503 ms under contention) | `bun run.ts cpu` |
| CPU EP p50, 20 runs, 1 thread, 13-14 tokens | 13.44 / 13.07 / 15.89 ms; first run 19.77 ms | `bun run.ts cpu` |
| CPU EP outputs | positive pPos=0.999863; negative pNeg=0.999799; neutral "meeting at three" pPos=0.876811 | `bun run.ts cpu` |
| CPU determinism | bit-identical over 20 runs; same logits hash bbb33218... across 2 processes; identical at THREADS=1,4,8 | `bun run.ts cpu \| grep -o logits \| shasum` (x2); `THREADS=4 bun run.ts cpu`; `THREADS=8 bun run.ts cpu` |
| CoreML EP | create 2111.6 ms; 59/532 nodes on CoreML in 28 partitions; p50 22.7 / 31.91 / 26.2 ms; bit-identical within the EP; neutral logits [-1.0026, 1.0851] vs CPU [-0.9522, 1.0104] (pPos 0.88971 vs 0.876811) | `bun run.ts coreml` |
| onnxruntime-web wasm, 1 thread | create 1215.8 ms; p50 163.69 / 132.42 / 116 ms; bit-identical over 20 runs; logits match CoreML, not node CPU | `bun run-web.ts` |
| onnxruntime-web wasm, 4 threads | p50 89.26 / 82.28 / 73.85 ms; deterministic | `THREADS=4 bun run-web.ts` |
| CPU EP under contention | THREADS=1 p50 110.63 / 57.3 / 24.31; THREADS=4 32.04 / 32.75 / 41.19; THREADS=8 46.47 / 86.38 / 65.66 ms | `for t in 1 4 8; do THREADS=$t bun run.ts cpu; done` |
| Disk footprint | full onnxruntime-node unpack 301,068,136 bytes; darwin-arm64-only extract about 45 MB (libonnxruntime.1.dylib 44,589,928 + binding 266,840); ort-web wasm 14,239,897 bytes | `npm view onnxruntime-node dist.unpackedSize; ls -l ...` |

Install note: a plain `bun add onnxruntime-node @huggingface/transformers` failed with `error: ENOSPC extracting tarball from onnxruntime-node`. The lane worked around it by stream-extracting only the darwin-arm64 files. @huggingface/transformers was not tested.

Verdict: ORT runs under Bun and is deterministic when one EP is pinned. Results across EPs differ at the 1e-2 level. On this model CPU beat CoreML on latency.

### Lane C - laya-local - FAILED (blocked, nothing measured)

| What | Measured | Command |
|---|---|---|
| Disk free (first check) | 241 MiB of 926 GiB (100% used) | `df -h /System/Volumes/Data` |
| Disk free (about 1 min later) | 186 MiB | `df -h /System/Volumes/Data \| tail -1` |
| venv creation | FAILED: `ensurepip --upgrade --default-pip` returned non-zero exit status 1 | `~/.pyenv/versions/3.11.4/bin/python -m venv .venv` |
| Harness writes | `ENOSPC: no space left on device` (2 consecutive calls) | `ls / venv retry; df -h` |
| Lane dir | 4.0K | `du -sh /Users/jamesspalding/wt/engine-spike/laya` |

Install size, cold start, latency, device, response shape, quality and ONNX export were all left untested. The chair ran `df -h /System/Volumes/Data` while writing this report and saw 17 GiB free, so the lane can be re-run unchanged.

### Lane D - Security review - WORKED

| Candidate | Verdict | Evidence (command) |
|---|---|---|
| onnxruntime-web 1.30.0 | OK to bundle. MIT, Microsoft, no install scripts, provenance=False. Ship the wasm locally and set `wasmPaths`, because transformers.js otherwise fetches the wasm from cdn.jsdelivr.net | `python3 security/npmmeta.py ...`; grep of `transformers.node.mjs` |
| onnxruntime-node 1.30.0 | Optional only. MIT, provenance=False, 301 MB unpacked. The postinstall does nothing on darwin/arm64. On linux/x64 it downloads CUDA 12 files from api.nuget.org and an ORT-Nightly Azure feed via `https.get`, with no hash or signature check | unpkg.com `script/install.js`, `install-metadata.js`, `install-utils.js` |
| @huggingface/transformers 4.3.0 | Optional only. Apache-2.0, no scripts of its own, but it pulls in onnxruntime-node (which has a postinstall), a nightly onnxruntime-web 1.31.0-dev.20260914-8d85527a0 and sharp ^0.35.4. It defaults to `allowRemoteModels: true` against huggingface.co, so force it to false | `npmmeta.py`; grep of dist |
| node-llama-cpp 3.22.1 | Optional only, never bundled. MIT, a single maintainer (giladgd), provenance=True, and the prebuilt mac-arm64-metal package (14.9 MB) also has provenance. Its postinstall is the same kind of install-time step PR #2969 removed: it loads the binding and, if that fails, compiles from source with cmake fetched through xpm. It can be turned off with `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` or `NODE_LLAMA_CPP_POSTINSTALL=skip` | unpkg.com `OnPostInstallCommand.js`, `config.js`, `getLlama.js`, `cmake.js`, `binariesGithubRelease.json` |
| laya 0.3.21 | Avoid for now. Apache-2.0, Convai Innovations, PyPI provenance present. 29 releases between 2026-09-18 and 2026-09-27. Needs torch>=2.0 and transformers>=4.48. Pulls weights from the HF Hub at the default revision unless `LAYA_REVISION` is set; pins are opt-in. No pickle, torch.load or trust_remote_code | `pip download laya==0.3.21 --no-deps`; pypi JSON + provenance; grep of source |
| Homebrew llama.cpp b7480 | Optional only, and only after `brew upgrade`. Poured from a checksummed bottle but only ad-hoc signed. Affected by CVE-2026-33298 (high, GGUF heap overflow, fixed in b7824) and CVE-2026-27940 (high, fixed in >= b8146). CVE-2026-34159 (critical, RPC backend RCE) lists no patched version. Formula stable is now 0.5.0 | `llama-cli --version; brew info llama.cpp; codesign -dv`; `gh api repos/ggml-org/llama.cpp/security-advisories` |

Unverified: whether the llama.cpp v0.5.0 bundled in node-llama-cpp includes the fixes for those two CVEs. That was inferred from version renumbering only.

### Lane E - Hardware adaptation matrix - WORKED

| What | Measured | Command |
|---|---|---|
| Host | darwin arm64, Apple M2 Max, 12 logical cores (8P+4E), 96 GB | `bun run probe.ts > probe-output.json` |
| GPU | 38 GPU cores, Metal 4 | `system_profiler SPDisplaysDataType -json` (in probe.ts) |
| system_profiler wall time | 23.54 s under pressure; 3.435 s later | `/usr/bin/time -p system_profiler SPDisplaysDataType` |
| Ollama | 0.34.2, 7 models, 1 MLX-format (qwen3.8:27b-mlx) | probe.ts `GET /api/version`, `/api/tags` |
| llama-server | build 7480; Metal: Apple M2 Max (79626 MiB); BLAS: Accelerate | `llama-server --version; --list-devices` |
| llama.cpp cold Metal init | 31.799 s and 40.102 s cold (41.42 s real); 0.809 s and 0.020 s warm | `/usr/bin/time -p llama-server --list-devices` |
| ONNX providers (python 1.24.3) | CoreML, Azure, CPU | `python3 -c 'import onnxruntime ...'` |
| MLX python | not installed (ModuleNotFoundError) | `python3 -c 'import mlx.core'` |
| Full probe | 66.42 s real | `/usr/bin/time -p bun run probe.ts` |

Full matrix: `/Users/jamesspalding/wt/engine-spike/matrix/matrix.md`. [F] marks cells fetched this session and [U] marks cells cited but not re-fetched. Only this macOS arm64 host was probed. The Windows and Linux branches of probe.ts have never been run.

---

## 2. Recommended architecture for M4/M5

### Runtimes 8gent-code should carry

1. **Primary in-process runtime: node-llama-cpp (GGUF, Metal), as an optional dependency.** It is the only lane that ran a generative decision model in-process under Bun with deterministic logits across processes (Lane A). Keep it optional and never bundled (Lane D). Install it with the postinstall disabled (`NODE_LLAMA_CPP_POSTINSTALL=skip`) and only accept the prebuilt platform binary, so there is no compile-from-source fallback.
2. **Secondary in-process runtime: onnxruntime-node on the CPU EP, for small classifier heads.** It measured 13-16 ms p50 for a 67 MB int8 classifier, bit-identical across runs, processes and thread counts (Lane B). Keep it optional, and install only the per-platform binding (about 45 MB on darwin-arm64, not 301 MB).
3. **Portable fallback: onnxruntime-web wasm, shipped locally.** It is deterministic and has no install scripts, but it was 8-10x slower than node CPU (Lane B). It is the only candidate cleared to bundle (Lane D). Set `wasmPaths` locally, and never let it reach a CDN.

### Per-platform backend order

For macOS arm64 (measured here), combining the Lane A and E findings:

1. In-process node-llama-cpp with Metal, loaded **once per engine lifetime** and kept warm. Warm loads were 336 ms for bindings and 1.7 s for the model, while cold loads ran 67-249 s. A cold Metal init in the llama-server CLI took 31.8-40.1 s.
2. A warm llama-server (Metal, GGUF, fixed seed, logprobs), as Lane E recommended. **Blocked until Homebrew llama.cpp is upgraded past b8146** (CVE-2026-33298 and CVE-2026-27940).
3. Ollama over HTTP on localhost:11434, which already holds the GGUF blobs.
4. llama.cpp CPU.
5. ONNX Runtime **CPU EP** for small heads. Lane E listed CoreML for this slot, but Lane B measured CoreML slower (22-32 ms against 13-16 ms p50), with only 59/532 nodes offloaded and logits different from CPU. So use CPU here.

Other platforms: follow `matrix/matrix.md`, with [U] cells treated as unverified. Windows arm64 relies on llama.cpp CPU (KleidiAI) plus ORT QNN, because the fetched docs show no DirectML and no Ollama for arm64. Android has no official Ollama. None of these has been run.

Detection: use `sysctl` plus `llama-server --list-devices`, or the equivalent binding query. Never put `system_profiler` in the startup path (3.4-23.5 s, Lane E).

### Determinism contract

- Pin **one backend and one EP per platform** and record it in every decision result. Cross-EP logits differ at the 1e-2 level (Lane B: CPU 0.876811 against CoreML 0.88971), so a switch of backend is a versioned change, not a transparent fallback.
- Score answers from logits only, never by sampling (Lane A method). Report `answerMassCoverage` next to p. A low coverage (Lane A saw 0.05-0.37) means the model did not really answer, and the engine should say so rather than return a confident-looking p.

### How micro decision models should be packaged

- A model is a manifest entry holding: file sha256, byte size, licence, source URL and revision, format (GGUF or ONNX), pinned backend and EP, prompt template, answer-token sets, and an optional calibration table. Load it only after the sha256 has been verified (Lane B matched the HF LFS oid, and Lane A verified an Ollama blob by digest).
- Reuse Ollama's content-addressed blob store when it is present (Lane A loaded the GGUF straight from `~/.ollama/models/blobs`). Do not make a second copy.
- Never fetch at runtime by default. Force `allowRemoteModels=false` and use local wasm paths (Lane D).
- Ship a calibration layer per model and question type. Neither measured model gives calibrated numbers out of the box: SST-2 rated a neutral sentence 0.877 positive, and MiniCPM5-1B scored "17 is prime" at 0.490.

### What we must NOT do yet

- Do not ship MiniCPM5-1B as the decision scorer. Coverage was 0.24-0.37, and it answers easy facts wrongly (Lane A).
- Do not bundle node-llama-cpp or onnxruntime-node, and do not let either run its postinstall (Lane D).
- Do not load GGUF through Homebrew llama.cpp b7480, and do not expose the llama.cpp RPC backend at all (CVE-2026-34159, no patch listed).
- Do not adopt laya (29 releases in 9 days, torch sidecar, weights unpinned by default). Nothing about it was measured (Lane C failed).
- Do not treat CoreML or wasm as interchangeable with CPU for determinism.
- Do not start one process per question (cold starts of 31.8-249 s in Lanes A and E).
- Do not publish latency targets from this spike as SLOs, because every number was taken under contention.

---

## 3. Next PR (this week)

**Title:** `feat(decide): deterministic logit scorer behind a pinned-backend interface, plus a labelled eval gate`

Scope: 8gent-code, one new package directory. The paths below are proposed and should be checked against the repo layout before branching. Branch from main, issue first.

Files:
- `packages/decide/scorer.ts` - `scoreYesNo(model, question) -> { pYes, answerMassCoverage, backend, ep, modelSha256 }`. This is the Lane A method (filtered logits, softmax over answer-token sets), behind a `DecisionBackend` interface.
- `packages/decide/backends/node-llama-cpp.ts` - lazy dynamic import. If the package is absent, return a typed `BackendUnavailable` error. Load once and keep warm.
- `packages/decide/manifest.ts` - the model manifest type plus sha256 verification before load.
- `packages/decide/eval/yesno.jsonl` - a small labelled set that includes the 4 spike questions. Any question about a destructive command lives in this file only, never on a command line.
- `packages/decide/scorer.test.ts` - tests.

Tests:
1. Determinism: the same question scored 20 times in one process gives identical logits, and two processes give pYes equal to 6 decimals. This reproduces the Lane A result.
2. Manifest: a model whose sha256 does not match is refused.
3. Absent backend: without node-llama-cpp installed, the scorer returns `BackendUnavailable` and does not throw or trigger a download.
4. Low coverage: when `answerMassCoverage` is under a threshold, the result is flagged `abstain` and no bare p is returned.
5. Eval gate (reports, does not block): accuracy and coverage per model on `yesno.jsonl`. With MiniCPM5-1B the expected result is FAIL, which is the evidence for picking the next model.

Success metric: tests 1-4 pass under `bun test`. The eval gate prints accuracy and mean coverage per model. Warm per-decision p50 is reported on the same 4 questions, against the reference of 54-117 ms measured in Lane A. No new required dependency: node-llama-cpp stays in `optionalDependencies` with postinstall skipped.

Not in this PR: ONNX backend, calibration fitting, choice/score question types, other platforms, llama-server path.

---

## 4. Open risks

1. **No usable decision model yet.** MiniCPM5-1B coverage was 0.24-0.37 with wrong answers on easy facts, and SST-2 is a sentiment model, not a decision model. Until a model passes the eval gate, the engine has no calibrated numbers.
2. **Cold start.** Loading the bindings took 67-249 s on first launch with near-zero CPU while trustd was busy. The suspected cause, a signature check of an unsigned .node binary, is not confirmed. llama.cpp Metal init took 31.8-40.1 s cold. Shipping needs a signed binary or an explicit warm-up step, and a confirmed root cause.
3. **Supply chain, llama.cpp.** Homebrew b7480 is behind CVE-2026-33298 and CVE-2026-27940 and is only ad-hoc signed. CVE-2026-34159 (critical, RPC RCE) lists no fixed version. Nobody has verified that node-llama-cpp's bundled v0.5.0 carries the fixes.
4. **Supply chain, install-time code.** node-llama-cpp's postinstall can compile from source and fetch cmake. onnxruntime-node's postinstall on linux/x64 downloads CUDA files from NuGet and a nightly Azure feed with no integrity check, and has no npm provenance. Both are gated to optional, with install steps skipped.
5. **Supply chain, runtime fetch.** transformers.js defaults to remote models (huggingface.co) and CDN wasm (jsDelivr), and pins a nightly onnxruntime-web. Both defaults must be forced off.
6. **laya churn.** 29 releases in 9 days and unpinned weights by default. It was not measured because Lane C failed on disk.
7. **Cross-backend drift.** CPU, CoreML and wasm give different logits (about 1e-2). Any automatic fallback silently changes answers unless the backend is recorded and versioned.
8. **Measurement quality.** All latencies were taken under load average 392 plus concurrent lanes, and CPU p50 at THREADS=1 swung from 13 ms to 110 ms. A clean re-run is needed before any number becomes a target.
9. **Disk.** The data volume ran down to 105-350 MB free during the spike and broke Lane C and parts of Lane B. At the time of this report it had 17 GiB free (`df -h /System/Volumes/Data`). Model packaging must account for size: onnxruntime-node is 301 MB unpacked and the GGUF is 1.15 GB.
10. **Unverified platforms.** Only macOS arm64 was probed. The Windows, Linux and Android backend orders rest on docs, some of them not re-fetched ([U]).
11. **Tokenizer.** The TS WordPiece tokenizer from Lane B has not been checked against the reference tokenizer.

## Verification (2026-09-28)

An independent skeptic re-ran the four load-bearing claims: Lane A determinism, Lane A model quality, Lane B CPU determinism and latency, and Lane B CoreML vs CPU. Every probability, coverage figure and hash matched to the printed precision, and latencies fell inside or below the reported ranges. There is one correction. In Lane A, `bun decide.ts` uses the empty-think prefill, while `NOTHINK=0` uses the raw prompt. So those two commands are not a determinism pair. Determinism holds on the same command run in separate processes. The Laya lane was not measured, because the disk was full; it can be re-run unchanged.
