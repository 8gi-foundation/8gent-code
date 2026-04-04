/**
 * When the model ends a turn without inviting the user (no question in the tail),
 * append a short follow-up so the UI does not feel stuck on "awaiting command".
 */

const CLOSING_MARKER = "Where should we steer next";

export function appendClosingQuestionIfNeeded<T extends { role: string; content: string }>(
  messages: T[],
): T[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return messages;

  const last = messages[lastAssistantIdx];
  const t = last.content.trim();
  if (t.length < 40) return messages;
  if (t.includes(CLOSING_MARKER)) return messages;

  const tail = t.slice(-280);
  if (/[?？]/.test(tail)) return messages;

  if (/\b(🎯\s*COMPLETED|🔴\s*INCOMPLETE)\b/.test(t)) return messages;

  const followUp =
    "\n\n" +
    CLOSING_MARKER +
    " - deeper here, another part of the repo, or start implementing something concrete?";

  return messages.map((m, i) =>
    i === lastAssistantIdx ? { ...m, content: m.content + followUp } : m,
  );
}
