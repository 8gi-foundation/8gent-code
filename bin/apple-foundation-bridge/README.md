# apple-foundation-bridge

Tiny Swift bridge that exposes Apple's on-device `FoundationModels.SystemLanguageModel` as a stdin/stdout JSON-line IPC server. Used by 8gent-code's `apple-foundation` runtime client.

## Requirements

- macOS 26 (Tahoe) or later
- Apple Silicon (arm64)
- Swift toolchain (Xcode 16+ or `xcode-select --install`)

## Build

```bash
swift build -c release
```

The binary lands at `.build/release/AppleFoundationBridge`. The 8gent installer copies it to `~/.8gent/bin/apple-foundation-bridge` and the runtime client spawns it on first chat call.

## Protocol

Stdin: one JSON object per line.

```json
{"messages":[{"role":"user","content":"hello"}],"model":"apple-foundation-system","maxTokens":256}
```

Stdout: one JSON object per line.

```json
{"model":"apple-foundation-system","message":{"role":"assistant","content":"Hi there."},"done":true,"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0},"error":null}
```

On error, `error` is populated and `message.content` is empty.

## v1 scope

- Non-streaming only
- Single-turn per request (prior turns are concatenated into the prompt string; real transcript-based multi-turn is v2)
- No tool calling
- No structured output (`@Generable`)
- No vision

License: Apache-2.0
