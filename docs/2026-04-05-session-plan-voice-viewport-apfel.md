# Session Plan: Voice Chat, Viewport Fix, Apfel Integration
**Date:** 2026-04-05
**Branch:** research/run-e-gemma4-lmstudio

---

## What Was Built This Session

### Completed
- **Issue B** — `FullDuplexProvider` interface + `detectCapabilities()` / `selectBestBackend()` in `packages/voice/full-duplex-provider.ts`
- **Issue C** — `MoshiMLXProvider` backend in `packages/voice/backends/moshi-mlx.ts`
  - Fixed `--backend mlx` → `--device mps` (moshi 0.2.13 flag correction)
  - Added `--hf-repo kyutai/moshiko-pytorch-bf16`
  - Moshi model downloaded (15GB, `~/.cache/huggingface/hub/models--kyutai--moshiko-pytorch-bf16`)
- **Issue A** — HyperAgent extraction into `packages/orchestration/sequential-pipeline.ts`
- **Voice chat working end-to-end** — Ctrl+R to record, Whisper STT, Gemma4 response via LM Studio
- **Embedding model filter** — `isLikelyEmbeddingModelId()` prevents `nomic-embed-text` being selected as chat model
- **`detectBestLocalProvider()`** — probes LM Studio (1234) → Ollama (11434) → Apfel (6660, placeholder)
- **Voice render fix** — timer 100ms → 500ms, audio level throttled 4/sec, minimal voice chat render mode
- **postinstall message** updated to reflect auto-detection

### Pending
1. **Viewport height clipping** — messages overflow into input area during chat
   - Fix: wrap `<MessageList>` in height-bounded `<Box>` in `app.tsx` case "chat"
   - `<Box height={Math.max(viewport.height - 8, 5)} overflow="hidden">`
2. **PR** — 13+ commits on `research/run-e-gemma4-lmstudio`, no PR opened yet
3. **Apfel activation** — port placeholder in `detectBestLocalProvider()` is `localhost:6660` (wrong, Apfel uses `11434`)
   - Fix after macOS 26 installs: detect Apple Silicon + FoundationModels availability
4. **Issue D** — `ExtensionCrafter` not started
5. **Moshi full-duplex routing** — `useVoiceChat` has TODO to route moshi-cpu/mlx to `MoshiMLXProvider.stream()`

---

## Apfel Integration Plan (post macOS 26 Tahoe install)

**What:** Apfel wraps Apple's FoundationModels framework (macOS 26+, Apple Silicon only).
Provides OpenAI-compatible endpoint, zero cost, on-device, ~4096 context.

**Repo:** https://github.com/Arthur-Ficial/apfel.git

**Current state in 8gent-code:**
- Referenced in `detectBestLocalProvider()` at `app.tsx:283` but port is wrong (6660 vs 11434)
- No SDK dependency, just a URL probe

**Fix needed after upgrade:**
```ts
// In detectBestLocalProvider(), replace Apfel probe:
const isAppleSilicon = process.arch === "arm64" && process.platform === "darwin";
if (isAppleSilicon) {
  // Apfel runs on same port as Ollama — detect by model name pattern
  // or configure Apfel to use a dedicated port (e.g. 11435)
}
```

**Also add to `selectBestBackend()` in `full-duplex-provider.ts`:**
- `apfel` backend type for full-duplex via FoundationModels

---

## Disk Space Notes
- **Freed:** Qwen2.5-Coder-14B (28GB HF cache deleted)
- **Current free:** ~38GB
- **macOS 26 Tahoe Beta install:** 18.25GB needed — cleared
- **Keep:** Moshi model (15GB), Kokoro TTS (4.2GB), Whisper base.en (141MB)

---

## Files Modified This Session
| File | Change |
|------|--------|
| `packages/voice/full-duplex-provider.ts` | FullDuplexProvider interface, detectCapabilities, selectBestBackend, MOSHI_HF_REPO |
| `packages/voice/backends/moshi-mlx.ts` | MoshiMLXProvider — fixed device flag, hf-repo arg, WS types |
| `packages/voice/backends/index.ts` | Re-exports |
| `packages/orchestration/sequential-pipeline.ts` | HyperAgent extraction |
| `apps/tui/src/hooks/useVoiceInput.ts` | Timer 500ms, audio level throttle 4/sec |
| `apps/tui/src/hooks/useVoiceChat.ts` | Backend detection wired in |
| `apps/tui/src/app.tsx` | detectBestLocalProvider, embedding filter, voice render mode, Apfel placeholder |
| `package.json` | postinstall message |
