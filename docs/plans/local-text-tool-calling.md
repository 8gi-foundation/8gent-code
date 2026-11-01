# Plan: Harness-side (text-protocol) tool calling for tool-incapable local models

## Why
8gent-code's agent loop assumes native OpenAI tool-calling. Strong local models
(e.g. the LM Studio gemma coder) can generate code but their served chat template
rejects a `tools` payload, so the harness cannot drive them agentically and Flow's
heavy path falls back to the cloud. Goal: make ANY local model tool-capable by
having the HARNESS inject tool specs into the prompt and parse tool calls from the
model's text output — no dependence on native tool support.

## Constraints
- New, self-contained module first. Do NOT modify the live agent loop in this
  branch's early tasks (minimise blast radius).
- TDD. Pure/unit-testable, no network in tests.
- Match existing code style in `packages/ai`.
- Commit only the new files for each task (`git add` explicit paths).

## Tasks

### Task 1 — Core text-tool protocol module
File: `packages/ai/text-tools.ts` (+ `packages/ai/text-tools.test.ts`).
Export:
- `type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }`
- `type ParsedToolCall = { name: string; arguments: Record<string, unknown> }`
- `buildToolSystemPrompt(tools: ToolSpec[]): string` — render a clear instruction
  block listing every tool (name, description, parameter schema) and defining the
  call syntax: to call a tool the model emits a fenced block
  ```` ```tool_call ````  containing one JSON object `{"name","arguments"}`; it may
  emit several such blocks; normal prose is the final answer. The returned string
  MUST contain each tool's name and the literal fence token `tool_call`.
- `parseToolCalls(text: string): ParsedToolCall[]` — extract every well-formed
  ```` ```tool_call ```` JSON block; tolerate surrounding prose; skip malformed
  JSON blocks without throwing; preserve `arguments` as an object; return `[]` when
  none.
- `stripToolCalls(text: string): string` — the input text with all tool_call
  blocks removed, trimmed (the assistant's natural-language portion).

TDD tests must cover: prompt contains each tool name + the fence token; parse of
0, 1, and N calls; malformed-JSON block skipped (no throw); prose around blocks;
arguments object preserved; `stripToolCalls` removes blocks and keeps prose.

### Task 2 — One-round text-tool adapter
File: `packages/ai/text-tool-client.ts` (+ test).
Export `runTextToolTurn(opts)` where opts = `{ messages, tools, call }` and
`call: (messages) => Promise<string>` is an injected model function (so tests use a
mock, no network). It prepends `buildToolSystemPrompt(tools)` to the system message,
invokes `call`, and returns `{ content: string; toolCalls: ParsedToolCall[] }`
where content is `stripToolCalls(raw)` and toolCalls is `parseToolCalls(raw)`.
Tests (mock `call`): returns a tool_call block → toolCalls populated, content
stripped; returns prose only → toolCalls empty, content intact; returns malformed
block → toolCalls empty, content intact; system prompt actually carries the tool
instructions (assert the mock received them).

### Task 3 — Capability gate (boundary; do only if 1 & 2 green and time allows)
File: `packages/ai/text-tools.ts` add
`needsTextTools(opts: { supportsNativeTools: boolean }): boolean` returning
`!supportsNativeTools`. Document (in a top-of-file comment) the single intended
integration point in the agent loop. No live wiring of the loop in this task.

## Done = all tasks: tests green, committed, spec-reviewed, quality-reviewed.
