// 8gent-hands planner.
//
// Two modes:
//   1. "llm"  - POST to an OpenAI-compatible /v1/chat/completions endpoint
//               (default: local Ollama at http://localhost:11434/v1).
//               Falls through to stub on any failure.
//   2. "stub" - regex / keyword vocabulary so the v0 still works offline
//               with no API keys, no model running.
//
// The planner ONLY plans. It never invokes cua-driver. That happens in run.ts.
//
// Env knobs:
//   HANDS_PLANNER       "llm" | "stub"   (default "llm" with stub fallback)
//   HANDS_LLM_BASE_URL  default http://localhost:11434/v1
//   HANDS_LLM_MODEL     default qwen3:32b  (matches what's installed locally)
//   HANDS_LLM_API_KEY   only sent if set; ollama ignores it

import type { PlannedStep } from "./types.ts";
import { STUB_TOOLS } from "./types.ts";

const SYSTEM_PROMPT = `You are the planner for 8gent-hands, a Mac computer-use agent.
Translate the user's natural-language request into a JSON array of tool calls
for cua-driver. Output ONLY a JSON array. No prose. No code fences.

Available tools (subset):
- screenshot          args: {} or {"pid": <int>, "window_id": <int>}
- list_apps           args: {"running_only": true}
- list_windows        args: {}
- get_screen_size     args: {}
- get_cursor_position args: {}
- click               args: {"pid": <int>, "x": <int>, "y": <int>}
- type_text           args: {"pid": <int>, "text": "<string>"}
- launch_app          args: {"bundle_id": "<string>"}
- check_permissions   args: {}

Each step is: {"tool": "<name>", "args": {...}, "rationale": "<one sentence>"}.
If the request is ambiguous, pick the simplest interpretation. If you cannot
plan, return [].`;

interface LlmStep {
  tool?: unknown;
  args?: unknown;
  rationale?: unknown;
}

function coerceSteps(raw: unknown): PlannedStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlannedStep[] = [];
  for (const item of raw as LlmStep[]) {
    if (!item || typeof item.tool !== "string") continue;
    const args =
      item.args && typeof item.args === "object" && !Array.isArray(item.args)
        ? (item.args as Record<string, unknown>)
        : {};
    const rationale =
      typeof item.rationale === "string" ? item.rationale : undefined;
    out.push({ tool: item.tool, args, rationale });
  }
  return out;
}

function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  // Strip markdown fences if the model added them despite instructions.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  // Pull from the first '[' to the last ']' so chatty preludes don't break us.
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function planWithLlm(prompt: string): Promise<{
  plan: PlannedStep[];
  model: string;
} | null> {
  const baseUrl =
    process.env.HANDS_LLM_BASE_URL ?? "http://localhost:11434/v1";
  const model = process.env.HANDS_LLM_MODEL ?? "qwen3:32b";
  const apiKey = process.env.HANDS_LLM_API_KEY;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        stream: false,
      }),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonArray(content);
    const plan = coerceSteps(parsed);
    if (plan.length === 0) return null;
    return { plan, model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stub planner. No LLM, no network. Maps a small vocabulary to known tools.
 * Always returns a plan (possibly empty) - never throws.
 */
export function planWithStub(prompt: string): PlannedStep[] {
  const text = prompt.toLowerCase();

  // "click at X Y" or "click X,Y"
  const clickMatch = text.match(/click\s+(?:at\s+)?(\d{1,5})[\s,x]+(\d{1,5})/);
  if (clickMatch) {
    const pidMatch = text.match(/pid\s+(\d+)/);
    return [
      {
        tool: "click",
        args: {
          x: Number(clickMatch[1]),
          y: Number(clickMatch[2]),
          ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
        },
        rationale: "stub: regex matched click coordinates",
      },
    ];
  }

  if (/\b(screenshot|screen ?shot|capture screen|take a (screen)?shot)\b/.test(text)) {
    return [{ tool: "screenshot", args: {}, rationale: "stub: keyword screenshot" }];
  }
  if (/\blist (apps|applications|running apps)\b/.test(text)) {
    return [
      {
        tool: "list_apps",
        args: { running_only: true },
        rationale: "stub: keyword list_apps",
      },
    ];
  }
  if (/\blist windows\b/.test(text)) {
    return [{ tool: "list_windows", args: {}, rationale: "stub: keyword list_windows" }];
  }
  if (/\bscreen size\b/.test(text)) {
    return [{ tool: "get_screen_size", args: {}, rationale: "stub: keyword screen size" }];
  }
  if (/\bcursor( position)?\b/.test(text)) {
    return [
      {
        tool: "get_cursor_position",
        args: {},
        rationale: "stub: keyword cursor position",
      },
    ];
  }
  if (/\b(check )?permissions?\b/.test(text)) {
    return [{ tool: "check_permissions", args: {}, rationale: "stub: keyword permissions" }];
  }

  return [];
}

export function stubVocabulary(): readonly string[] {
  return STUB_TOOLS;
}
