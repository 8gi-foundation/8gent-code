/**
 * Tests for the adaptive pipeline's deterministic core: the obstacle
 * classifier and the decision palette. Model calls are not exercised here -
 * they are integration-tested by `8gent pipeline` against live local models.
 */

import { describe, expect, test } from "bun:test";
import {
	DecisionPalette,
	Obstacle,
	ObstacleClassifier,
	ObstacleType,
	Severity,
	staticChecks,
} from "./adaptive-pipeline";

describe("ObstacleClassifier", () => {
	const c = new ObstacleClassifier();

	test("a context-window error is a moderate ContextOverflow", () => {
		const o = c.classify("exceededContextWindowSize: 4089 tokens", "", { code: false });
		expect(o?.type).toBe(ObstacleType.ContextOverflow);
		expect(o?.severity).toBe(Severity.Moderate);
	});

	test("a timeout error is a trivial Timeout", () => {
		const o = c.classify("Error: The operation timed out", "", { code: false });
		expect(o?.type).toBe(ObstacleType.Timeout);
		expect(o?.severity).toBe(Severity.Trivial);
	});

	test("a compute error is a severe ProviderUnhealthy", () => {
		const o = c.classify('lmstudio 400: {"error":"Compute error."}', "", { code: false });
		expect(o?.type).toBe(ObstacleType.ProviderUnhealthy);
		expect(o?.severity).toBe(Severity.Severe);
	});

	test("a clean non-code output has no obstacle", () => {
		const plan =
			"1. Set up the Three.js scene and camera. 2. Add lighting. 3. Build the rotating centerpiece geometry. 4. Wire the animation loop. 5. Overlay the hero text and CTA.";
		expect(c.classify(null, plan, { code: false })).toBeNull();
	});

	test("a truncated HTML file is a Truncation obstacle", () => {
		const truncated = `<!doctype html><html lang="en"><head><title>Portfolio</title></head>
<body><div id="app"></div><script>const x = 1; requestAnimationFrame(() => {});`;
		const o = c.classify(null, truncated, { code: true });
		expect(o?.type).toBe(ObstacleType.Truncation);
	});

	test("HTML with a JS syntax error is a SyntaxError obstacle", () => {
		const bad = `<!doctype html><html lang="en"><head><title>Portfolio</title></head>
<body><div id="app"></div><script>
function animate() requestAnimationFrame(animate); const x = 1;
</script></body></html>`;
		const o = c.classify(null, bad, { code: true });
		expect(o?.type).toBe(ObstacleType.SyntaxError);
		expect(o?.severity).toBe(Severity.Severe);
	});

	test("a complete, valid HTML file has no obstacle", () => {
		const good = `<!doctype html><html lang="en"><head><title>Portfolio</title></head>
<body><div id="app"></div><script>
function loop() { requestAnimationFrame(loop); }
loop();
</script></body></html>`;
		expect(c.classify(null, good, { code: true })).toBeNull();
	});
});

describe("DecisionPalette is deterministic", () => {
	const palette = new DecisionPalette(3);

	test("the same obstacle at the same attempt always yields the same decision", () => {
		const o = new Obstacle(ObstacleType.SyntaxError, Severity.Severe, "x");
		const a = palette.decide(o, 0, true);
		const b = palette.decide(o, 0, true);
		expect(a.strategy).toBe(b.strategy);
	});

	test("provider-unhealthy always reassigns", () => {
		const o = new Obstacle(ObstacleType.ProviderUnhealthy, Severity.Severe, "down");
		expect(palette.decide(o, 0, true).strategy).toBe("reassign");
	});

	test("a timeout retries first, then escalates", () => {
		const o = new Obstacle(ObstacleType.Timeout, Severity.Trivial, "slow");
		expect(palette.decide(o, 0, true).strategy).toBe("retry");
		expect(palette.decide(o, 1, true).strategy).toBe("escalate");
	});

	test("context overflow shrinks the input", () => {
		const o = new Obstacle(ObstacleType.ContextOverflow, Severity.Moderate, "too big");
		expect(palette.decide(o, 0, true).strategy).toBe("shrink-input");
	});

	test("truncation raises the budget first, then escalates", () => {
		const o = new Obstacle(ObstacleType.Truncation, Severity.Moderate, "cut off");
		expect(palette.decide(o, 0, true).strategy).toBe("raise-budget");
		expect(palette.decide(o, 1, true).strategy).toBe("escalate");
	});

	test("a syntax error routes to repair", () => {
		const o = new Obstacle(ObstacleType.SyntaxError, Severity.Severe, "bad js");
		expect(palette.decide(o, 0, true).strategy).toBe("repair");
	});

	test("budget exhausted aborts an essential stage but skips an optional one", () => {
		const o = new Obstacle(ObstacleType.EmptyOutput, Severity.Moderate, "empty");
		expect(palette.decide(o, 3, true).strategy).toBe("abort");
		expect(palette.decide(o, 3, false).strategy).toBe("skip");
	});
});

describe("severity ladder", () => {
	test("severities are strictly ordered", () => {
		expect(Severity.Trivial).toBeLessThan(Severity.Moderate);
		expect(Severity.Moderate).toBeLessThan(Severity.Severe);
		expect(Severity.Severe).toBeLessThan(Severity.Blocking);
	});

	test("an obstacle renders its grade and type", () => {
		const o = new Obstacle(ObstacleType.SyntaxError, Severity.Severe, "missing brace");
		expect(o.toString()).toContain("Severe");
		expect(o.toString()).toContain("syntax-error");
	});
});

describe("staticChecks", () => {
	test("flags a truncated file", () => {
		expect(staticChecks("<html><body>no closing tag").some((d) => /TRUNCATED/.test(d))).toBe(
			true,
		);
	});

	test("flags a JS syntax error", () => {
		const bad = "<html><body><script>const = 5</script>\n</body></html>";
		expect(staticChecks(bad).some((d) => /SYNTAX ERROR/.test(d))).toBe(true);
	});

	test("passes a complete valid file", () => {
		const good =
			"<html><body><script>function loop(){requestAnimationFrame(loop)}loop()</script>\n</body></html>";
		expect(staticChecks(good)).toEqual([]);
	});
});
