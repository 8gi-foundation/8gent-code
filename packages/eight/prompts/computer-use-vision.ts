/**
 * Vision prompt template for the computer-use loop.
 *
 * Optimized for the local Qwen 3.6-27B vision/tool tier and shaped to fall
 * back gracefully on the cloud heavy tier (DeepSeek V4-Flash, no vision)
 * by stripping the image part and keeping the text scaffolding identical.
 *
 * Treat this template as a tunable. Keep it small; image tokens are the
 * dominant cost. The template never names a vendor by brand.
 */

import type { Message, MessageContent, MessageContentPart } from "../types";

export interface VisionPromptInput {
	goal: string;
	/** Step number, 1-indexed, for the model's planning context. */
	step: number;
	maxSteps: number;
	/** Compact summary of the perception payload (tree summary or screenshot label). */
	perceptionSummary: string;
	/** If a screenshot was captured, its data URL. */
	screenshotDataUrl?: string;
	/**
	 * Optional region annotation, in the form
	 * `{x,y,width,height}`. Helps the model focus when the screenshot is large.
	 */
	region?: { x: number; y: number; width: number; height: number };
	/**
	 * Last action result (one line). Empty on the first step.
	 */
	lastActionResult?: string;
}

const FALLBACK_NOTE_NO_VISION =
	"(Heavy cloud tier active: vision disabled, reason about the tree summary alone.)";

/**
 * Build the user-turn message for the vision tier.
 *
 * Shape:
 *   - text: step header + perception summary + optional last-action result
 *   - image: only when `screenshotDataUrl` is provided
 *
 * If the runner detects the chain has failed over to the heavy cloud tier
 * (no vision), it should call `buildVisionPrompt` with `screenshotDataUrl`
 * undefined. The text scaffolding is identical so the model sees a
 * consistent format across tiers.
 */
export function buildVisionPrompt(input: VisionPromptInput): Message {
	const {
		goal,
		step,
		maxSteps,
		perceptionSummary,
		screenshotDataUrl,
		region,
		lastActionResult,
	} = input;

	const headerLines = [`Step ${step} of ${maxSteps}.`, `Goal: ${goal}`];
	if (lastActionResult) headerLines.push(`Last action: ${lastActionResult}`);

	const perceptionLines = ["Perception:", perceptionSummary];
	if (region) {
		perceptionLines.push(
			`Region of interest: x=${region.x} y=${region.y} w=${region.width} h=${region.height}`,
		);
	}

	const tailLines = [
		"Decide the next action. Prefer tree-only reasoning when possible.",
		"Reply by calling exactly one tool.",
	];

	const text = [...headerLines, "", ...perceptionLines, "", ...tailLines].join(
		"\n",
	);

	if (!screenshotDataUrl) {
		return {
			role: "user",
			content: `${text}\n\n${FALLBACK_NOTE_NO_VISION}`,
		};
	}

	const parts: MessageContentPart[] = [
		{ type: "text", text },
		{ type: "image_url", image_url: { url: screenshotDataUrl } },
	];
	const content: MessageContent = parts;
	return { role: "user", content };
}

/**
 * Strip the image part from a vision-shape message. The runner uses this
 * to retry the same step on a non-vision tier without rebuilding the
 * message scaffolding.
 */
export function stripVisionParts(message: Message): Message {
	if (typeof message.content === "string") return message;
	const textOnly = message.content
		.filter((p) => p.type === "text")
		.map((p) => (p as MessageContentPart).text ?? "")
		.join("\n");
	return {
		...message,
		content: `${textOnly}\n\n${FALLBACK_NOTE_NO_VISION}`,
	};
}
