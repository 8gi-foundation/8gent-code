/**
 * Notify Actuators
 *
 * Send messages to the outside world: Telegram, GitHub issues.
 * Uses fetch for HTTP APIs, Bun.spawn for CLI tools. All respect dryRun.
 */

import { type ActuatorConfig, type ActuatorResult, ok, fail, checkTarget, log } from "./types";

/**
 * Send a Telegram message via Bot API
 *
 * Bot token and chat ID passed as parameters — never imported from env.
 * Reversible: no — messages can't be unsent via bot API (without message ID tracking).
 */
export async function sendTelegram(
  botToken: string,
  chatId: string,
  message: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "notify:telegram";
  const target = `chat:${chatId}`;

  const blocked = checkTarget(chatId, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, `Message (${message.length} chars)`);

  if (config.dryRun) {
    return ok(action, target, `DRY RUN: would send to Telegram chat ${chatId}:\n${message}`);
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    const data = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };

    if (!data.ok) {
      return fail(action, target, `Telegram API error: ${data.description || "unknown"}`);
    }

    return ok(action, target, `Message sent (id: ${data.result?.message_id})`);
  } catch (err) {
    return fail(action, target, `Fetch error: ${(err as Error).message}`);
  }
}

/**
 * Post a comment on a GitHub issue/PR (uses `gh api`)
 *
 * Requires: `gh` CLI authenticated.
 * Reversible: yes — delete the comment via API.
 */
export async function postToGitHubIssue(
  repo: string,
  issueNumber: number,
  comment: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "notify:github-issue";
  const target = `${repo}#${issueNumber}`;

  const blocked = checkTarget(repo, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, `Comment (${comment.length} chars)`);

  if (config.dryRun) {
    return ok(action, target, `DRY RUN: would comment on ${repo}#${issueNumber}:\n${comment}`, {
      reversible: true,
      undoCommand: `gh api repos/${repo}/issues/comments/<id> -X DELETE`,
    });
  }

  const proc = Bun.spawn(
    [
      "gh", "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "-X", "POST",
      "-f", `body=${comment}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return fail(action, target, `Exit ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }

  // Extract comment ID from response for undo
  let commentId: string | undefined;
  try {
    const parsed = JSON.parse(stdout) as { id?: number };
    commentId = parsed.id?.toString();
  } catch {
    // Non-critical — undo command just won't have the ID
  }

  return ok(action, target, `Comment posted on ${repo}#${issueNumber}`, {
    reversible: true,
    undoCommand: commentId
      ? `gh api repos/${repo}/issues/comments/${commentId} -X DELETE`
      : `gh api repos/${repo}/issues/comments/<id> -X DELETE`,
  });
}
