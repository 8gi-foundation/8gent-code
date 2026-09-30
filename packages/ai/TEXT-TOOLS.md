# Text-Protocol Tool Calling

Harness-side tool calling for local models that have no native tool-calling API.

## The problem

Many local models cannot accept a native OpenAI-style `tools` payload. Their
served chat template was built without tool support, so sending a `tools` field
makes the server return a 400 (some LM Studio GGUF chat templates do exactly
this). The model itself is perfectly capable of following instructions and
emitting structured text; it just has no native tool-calling channel.

The fix is to keep tool orchestration in the harness. Instead of asking the
provider to parse and route tool calls, the harness teaches the model the
protocol in plain text via the system prompt, then parses the model's plain-text
reply for tool calls itself. Any local model becomes tool-capable this way, with
no dependency on the server's chat template.

## The three primitives

All three live in `packages/ai/text-tools.ts` and are pure (no I/O, no network).

- `buildToolSystemPrompt(tools: ToolSpec[]): string`
  Renders the instruction block that teaches the model the protocol: how to emit
  a fenced ` ```tool_call ` block containing one JSON object
  `{"name": "...", "arguments": {...}}`, plus the full list of available tools
  (name, description, parameter schema). Inject this into the system prompt.

- `parseToolCalls(text: string, opts?: { knownTools?: Iterable<string> }): ParsedToolCall[]`
  Extracts every well-formed `tool_call` block from a model reply. The block
  body is bounded by a balanced JSON object, so a ` ``` ` or a brace inside a
  JSON string value (for example file content) parses correctly. Malformed
  blocks are skipped, never thrown. `"parameters"` is accepted in place of
  `"arguments"`.

  Bare JSON fallback: small local models (ollama llama3.2:3b) often skip the
  `tool_call` fence and write `{"name": ..., "arguments": {...}}` bare or in a
  plain ` ``` ` / ` ```json ` fence. When `knownTools` is given (the adapter
  passes the registered tool names) and the reply has no parsed `tool_call`
  block, those objects are taken as calls, in order, but only when the name is
  a registered tool, the object has an `arguments`/`parameters` object, it
  stands on its own lines (not inline in a sentence), it is not nested in
  another object, and it is not inside a fence tagged with another language
  (` ```ts `, ` ```python `). JSON examples in an answer therefore never run.

- `stripToolCalls(text: string, opts?: { knownTools?: Iterable<string> }): string`
  Removes every `tool_call` block and returns the remaining prose, trimmed. Use
  it to recover the model's natural-language answer with no JSON shrapnel left.

## The adapter

`runTextToolTurn` in `packages/ai/text-tool-client.ts` wires the three
primitives to an injected model call. Given a conversation and a tool set, it
injects the instructions into the system prompt, runs ONE model turn through the
caller's `call` function, then returns the stripped prose plus any parsed tool
calls. It performs no network or I/O of its own and never mutates the caller's
messages.

## Ollama's built-in parser (#3012)

Ollama runs the model's own output parser (for qwen3.8, `PARSER qwen3.5`) on
every `/v1/chat/completions` and `/api/chat` reply, even with no `tools` in the
request, and the chat endpoints have no switch to turn it off. If a reply holds
the model's native `<tool_call>` tag, that parser takes over: a closed tag with
a JSON body fails XML parsing and the request becomes a 500 (`EOF`); an
unclosed tag, or one mentioned in the model's reasoning, makes the reply come
back 200 with empty content. Two rules follow:

- `buildToolSystemPrompt` must never spell out a native marker (`<tool_call>`,
  `<|tool_call|>`, `<function=`). It forbids them in words. A test pins this.
- `buildTextToolCall` (`text-tool-endpoint.ts`) retries exactly once, with a
  reminder to use the fenced block, when Ollama returns that parser 500 or an
  empty reply for tokens it generated. A second parser 500 fails with a clear
  error; a second empty reply is returned as is.

A third case is silent. When the parser SUCCEEDS on a well-formed
`<tool_call><function=...>` block, it strips the call from `content` and only
returns it in `message.tool_calls` if the request declared that tool. With no
`tools` field the call is thrown away, the prose before it ("Let me check the
root README.") comes back 200, and the loop reads a reply with no call: a stall.
Seen on qwen3.8:27b-mlx, Ollama 0.34.4, 2026-09-30. So for provider `ollama`,
`buildTextToolCall` declares the registered tools (`opts.tools`), reads
`message.tool_calls` back, and resolves to `{ content, toolCalls }`.
`runTextToolTurn` dedupes them against calls written in the text. A model
that 400s with "does not support tools" is sent again without them.
`EIGHT_TEXT_TOOLS_DECLARE=0` turns the declaration off.

Once any tool is declared, the parser also returns calls to names that were
NOT declared: qwen3.8 answered "call spawn_agent" with a structured
`spawn_agent` call and empty `content` while only the 20 local tools were
declared (#3091, 2026-09-30). Such a call is kept, never run, and answered with
`Error: no tool named "spawn_agent" is available. Available tools: ...`, so
the model learns it does not exist. It used to be dropped: the model was told
its reply "had no tool_call block", retried the same call, and the turn ended
with an empty answer recorded as ok.

## Empty final reply

A reply with no text and no call, after the turn has run tools, is never a
finished turn. It gets the completion check inside the same budget as any
other stall. If the budget is spent (or the round cap ends a tool-calls-only
turn), the answer is a `[harness]` line saying the turn ended without a reply,
and the same line is returned in `unverified`, so the run log never records a
silent empty turn as clean.

## The gate

`needsTextTools({ supportsNativeTools }): boolean` in
`packages/ai/text-tools.ts` is the single decision point. It returns
`!supportsNativeTools`: a provider/model that cannot accept a native `tools`
payload should be driven through the text protocol instead.

## Intended integration point (not yet wired)

This module is code-and-doc only. The live agent loop and providers are not
changed here; wiring them is a separate, riskier follow-up. The intended hooks,
verified against the current source:

### 1. Provider request body

`packages/providers/index.ts`, method `chatOpenAICompatible` (defined around
line 721). The native-tools gate is around lines 753-755:

```ts
if (request.tools && request.tools.length > 0 && provider.supportsTools) {
	body.tools = request.tools;
}
```

`provider.supportsTools` is the `supportsTools: boolean` field on the provider
config (declared around line 61). When
`needsTextTools({ supportsNativeTools: provider.supportsTools })` is true, the
loop should NOT set `body.tools`. The condition above already omits `body.tools`
when `provider.supportsTools` is false, so the native payload is correctly left
off; the remaining work is on the agent side, where the text protocol takes
over.

### 2. Agent tool attachment

`packages/ai/agent.ts`, function `createEightAgent` (defined around line 138).
Tools are resolved around line 191 (`const tools = (config.tools as AgentTools) || defaultTools;`)
and attached to the AI SDK `ToolLoopAgent` around line 213 (the `tools,` entry
inside the `new ToolLoopAgent<never, AgentTools>({ ... })` call that begins
around line 195).

When `needsTextTools({ supportsNativeTools: config.provider.supportsTools })` is
true, this is where the loop should diverge from the native `ToolLoopAgent`
path. In prose, the intended behavior:

1. Omit the native `tools` from the model request (see section 1).
2. Inject `buildToolSystemPrompt(toolSpecs)` into the system prompt
   (`config.instructions`), so the model learns the text protocol.
3. Run the turn, then parse the model's text reply with `parseToolCalls` to
   recover any requested calls.
4. Execute those calls against the same tool implementations the native path
   uses, then feed the results back as a follow-up message (a `tool`-role or
   user message), and repeat until the model emits prose with no further calls.
5. Use `stripToolCalls` on the final reply to present clean prose to the user.

`runTextToolTurn` already encapsulates steps 2-3 and the strip in step 5 for a
single round; the loop wraps it with execution and the follow-up message.

Keeping this orchestration in the harness is the whole point: any local model,
regardless of whether its chat template supports a `tools` payload, becomes
tool-capable.
