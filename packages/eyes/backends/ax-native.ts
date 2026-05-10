/**
 * @8gent/eyes - native AX backend.
 *
 * Replaces the v0 Peekaboo subprocess backend (#2501) with a bundled Swift
 * helper at ~/.8gent/bin/8gent-ax-bridge. No Homebrew dependency, no
 * external CLI to install. The bridge is built locally from
 * packages/eyes/native/swift/ via packages/eyes/native/build.sh and copied
 * into the user's bin dir on first run.
 *
 * Spec: docs/specs/EYES-SPEC.md
 * Backend rationale: docs/specs/EYES-BACKEND-AX-NATIVE.md
 *
 * Permission model:
 *   - capture, annotate, locate (AX), wait_for, diff, observe
 *     -> base computer-use tier (gated by control plane upstream)
 *   - describe, locate(kind: "describe") routed to a remote provider
 *     -> additionally gated by perception:remote tier per §4.2 / §8.4.
 *     The egress check fires on RUNTIME provider identity, not backend.
 *
 * The backend talks to a single bundled Swift binary that wraps Apple system
 * frameworks directly (CGDisplay*, NSScreen, AXUIElement*, /usr/sbin/screencapture).
 * No third-party Swift packages, no AXorcist, no Homebrew formula. Conceptual
 * ancestor of the bridge: Peekaboo (MIT, Peter Steinberger) - see
 * packages/eyes/native/NOTICE.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logAccess } from "@8gent/audit";
import { AnnotationCache, annotationKey } from "../cache.js";
import {
	checkPerceptionRemote,
	type CheckResult as PerceptionCheck,
} from "../perception-tier.js";
import { perceptualDiff } from "../utils/perceptual-diff.js";
import type {
	AnnotatedElement,
	AnnotatedFrame,
	BackendOpts,
	CaptureOpts,
	Description,
	DiffOpts,
	Disposable,
	Eyes,
	EyesBackend,
	Frame,
	FrameDiff,
	Locator,
	LocatorQuery,
	ObservationEvent,
	ObserveOpts,
	Predicate,
	WaitOpts,
	WaitResult,
} from "../index.js";
import {
	getFocusedScreen,
	listScreens,
	type ScreenInfo,
} from "../utils/display.js";
import {
	isBridgeAvailable,
	resolveBridgeBinary,
	runBridge,
	type BridgeRunOpts,
} from "../utils/ax-bridge.js";

// ---------------------------------------------------------------------------
// Bridge response shapes (subset we actually parse).
// ---------------------------------------------------------------------------

interface BridgeImageData {
	files: Array<{
		path: string;
		mime_type: string;
		window_id?: number | null;
		window_title?: string | null;
		item_label?: string | null;
		window_index?: number | null;
		logical_size?: { width: number; height: number };
		scale_factor?: number;
	}>;
}

interface BridgeSeeData {
	snapshot_id: string;
	screenshot_raw: string;
	screenshot_annotated?: string;
	ui_map?: string | null;
	application_name?: string | null;
	window_title?: string | null;
	is_dialog?: boolean;
	element_count?: number;
	interactable_count?: number;
	capture_mode?: string;
	execution_time?: number;
	ui_elements: Array<{
		id: string;
		role: string;
		title?: string | null;
		label?: string | null;
		description?: string | null;
		role_description?: string | null;
		help?: string | null;
		identifier?: string | null;
		bounds: { x: number; y: number; width: number; height: number };
		is_actionable?: boolean;
		keyboard_shortcut?: string | null;
		value?: string | null;
	}>;
}

interface BridgePermission {
	name: string;
	isRequired: boolean;
	isGranted: boolean;
	grantInstructions?: string;
}

// ---------------------------------------------------------------------------
// Provider hook for describe(). Injected via BackendOpts so the package keeps
// zero hard runtime dep on @8gent/providers (which would create a cycle).
// ---------------------------------------------------------------------------

export interface VisionRequest {
	frame: Frame;
	prompt: string;
}
export interface VisionResponse {
	provider: string;
	model: string;
	text: string;
	tokens?: number;
}

/**
 * Two-phase contract per spec §4.2 / §8.4.
 *
 * The eyes backend MUST call `resolveProviderId()` first, run the
 * perception:remote tier check on that id, and ONLY then call `describe()`.
 * This eliminates the v0 privacy bug (#2508) where the inference call
 * happened before the tier check.
 */
export interface VisionProvider {
	resolveProviderId(req: VisionRequest): Promise<string>;
	describe(req: VisionRequest): Promise<VisionResponse>;
}

export interface AxNativeBackendOpts extends BackendOpts {
	visionProvider?: VisionProvider;
	sessionId?: string;
	app?: string;            // bundle id of the active app, used in tier checks
	actor?: string;          // agent id, used in audit
	cacheTtlMs?: number;
	cacheMaxFrames?: number;
}

// ---------------------------------------------------------------------------
// Backend implementation.
// ---------------------------------------------------------------------------

const PLATFORM: Frame["platform"] = "darwin";

function newFrameId(): string {
	return `frm_${createHash("sha1").update(`${Date.now()}_${Math.random()}`).digest("hex").slice(0, 12)}`;
}

function ensureDir(p: string): void {
	const d = dirname(p);
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function frameOutputPath(displayId: number): string {
	const dir = join(tmpdir(), "8gent-eyes");
	const file = `${newFrameId()}_d${displayId}.png`;
	const path = join(dir, file);
	ensureDir(path);
	return path;
}

function frameFromImageResult(
	res: BridgeImageData,
	screen: ScreenInfo,
): Frame {
	const file = res.files[0];
	if (!file) throw new Error("8gent-ax-bridge image returned no files");
	return {
		id: newFrameId(),
		path: file.path,
		width: screen.resolution.width,    // logical per §8.1; raw_pixels = width * scale
		height: screen.resolution.height,
		displayId: screen.displayID,
		capturedAt: Date.now(),
		scale: screen.scaleFactor,
		platform: PLATFORM,
	};
}

function elementToAnnotated(
	e: BridgeSeeData["ui_elements"][number],
	app?: string,
	window?: string,
): AnnotatedElement {
	return {
		id: e.id,
		role: e.role,
		label: e.label ?? e.title ?? e.description ?? undefined,
		value: e.value ?? undefined,
		bbox: e.bounds,
		enabled: e.is_actionable ?? true,
		app,
		window,
	};
}

function locatorFromElement(
	el: AnnotatedElement,
	confidence: number,
	rationale: string,
): Locator {
	const cx = el.bbox.x + el.bbox.width / 2;
	const cy = el.bbox.y + el.bbox.height / 2;
	return {
		target: { point: { x: cx, y: cy } },
		confidence,
		source: "ax",
		bbox: el.bbox,
		rationale,
	};
}

class AxNativeEyes implements Eyes {
	readonly id = "ax-native";
	readonly backend = "ax-native";
	readonly available: boolean;

	private readonly opts: AxNativeBackendOpts;
	private readonly cache: AnnotationCache;

	constructor(opts: AxNativeBackendOpts, available: boolean) {
		this.opts = opts;
		this.available = available;
		this.cache = new AnnotationCache({
			ttlMs: opts.cacheTtlMs,
			maxFrames: opts.cacheMaxFrames,
		});
	}

	private runOpts(): BridgeRunOpts {
		return { binaryPath: this.opts.binaryPath };
	}

	private trace(op: string, targetId: string, reason: string, operation: "read" | "derive" | "export" = "read"): void {
		logAccess({
			actor: this.opts.actor ?? this.opts.sessionId ?? "system",
			actorKind: "agent",
			targetTable: "eyes_call",
			targetId,
			operation,
			reason: `${op}: ${reason}`,
			sessionId: this.opts.sessionId ?? null,
		});
	}

	// -------------------------------------------------------------------------
	// capture / captureAll
	// -------------------------------------------------------------------------

	async capture(opts: CaptureOpts = {}): Promise<Frame> {
		if (opts.displayId === "all") {
			const frames = await this.captureAll({
				region: opts.region,
				includeCursor: opts.includeCursor,
				format: opts.format,
			});
			if (!frames[0]) throw new Error("captureAll returned empty Frame[]");
			return frames[0];
		}

		const screen = await this.resolveTargetScreen(opts.displayId);
		const out = frameOutputPath(screen.index);
		const args: Record<string, unknown> = {
			mode: opts.region ? "area" : "screen",
			screenIndex: screen.index,
			path: out,
			format: opts.format === "jpeg" ? "jpg" : "png",
		};
		if (opts.region) {
			const r = opts.region;
			args.region = `${r.x},${r.y},${r.width},${r.height}`;
		}
		const r = await runBridge<BridgeImageData>("image", args, this.runOpts());
		if (!r.ok) throw new Error(`8gent-ax-bridge image failed: ${r.reason}`);
		const frame = frameFromImageResult(r.data, screen);
		this.trace("capture", frame.id, `display=${screen.index} scale=${screen.scaleFactor}`);
		return frame;
	}

	async captureAll(
		opts: Omit<CaptureOpts, "displayId"> = {},
	): Promise<Frame[]> {
		const screens = await listScreens(this.runOpts());
		const out: Frame[] = [];
		// Sequential: parallel screencaptures are flaky on macOS.
		for (const s of screens) {
			out.push(
				await this.capture({
					displayId: s.index,
					region: opts.region,
					includeCursor: opts.includeCursor,
					format: opts.format,
				}),
			);
		}
		this.trace("captureAll", `multi:${screens.length}`, `displays=${screens.map((s) => s.index).join(",")}`);
		return out;
	}

	private async resolveTargetScreen(
		displayId: CaptureOpts["displayId"],
	): Promise<ScreenInfo> {
		const screens = await listScreens(this.runOpts());
		if (typeof displayId === "number") {
			const byIndex = screens.find((s) => s.index === displayId);
			const byDisplayID = screens.find((s) => s.displayID === displayId);
			const found = byIndex ?? byDisplayID;
			if (!found) throw new Error(`no screen with index/displayID ${displayId}`);
			return found;
		}
		if (displayId === "primary") {
			const primary = screens.find((s) => s.isPrimary) ?? screens[0];
			if (!primary) throw new Error("no primary screen");
			return primary;
		}
		// Default per §8.2: focused display.
		return getFocusedScreen(this.runOpts());
	}

	// -------------------------------------------------------------------------
	// annotate / locate
	// -------------------------------------------------------------------------

	async annotate(frame: Frame): Promise<AnnotatedFrame> {
		const key = annotationKey(frame.id, frame.displayId);
		const cached = this.cache.get(key);
		if (cached) return cached;

		// Map displayID back to index by re-listing; rare path, accept the cost.
		const screens = await listScreens(this.runOpts());
		const s = screens.find((x) => x.displayID === frame.displayId) ?? screens[0];
		if (!s) throw new Error("annotate: no screens enumerated");

		const r = await runBridge<BridgeSeeData>(
			"see",
			{ screenIndex: s.index, path: frame.path },
			this.runOpts(),
		);
		if (!r.ok) throw new Error(`8gent-ax-bridge see failed: ${r.reason}`);
		const elements = r.data.ui_elements.map((e) =>
			elementToAnnotated(
				e,
				r.data.application_name ?? undefined,
				r.data.window_title ?? undefined,
			),
		);
		const annotated: AnnotatedFrame = { ...frame, elements };
		this.cache.set(key, annotated);
		this.trace(
			"annotate",
			frame.id,
			`elements=${elements.length} interactable=${r.data.interactable_count ?? "?"}`,
		);
		return annotated;
	}

	async locate(query: LocatorQuery, frame?: AnnotatedFrame): Promise<Locator[]> {
		if (query.kind === "coords") {
			return [{
				target: { point: { x: query.x, y: query.y } },
				confidence: 1,
				source: "coords",
				rationale: "coords-direct",
			}];
		}

		const af = frame ?? (await this.annotate(await this.capture()));

		if (query.kind === "id") {
			const el = af.elements.find((e) => e.id === query.id);
			return el ? [locatorFromElement(el, 1, `exact id match ${query.id}`)] : [];
		}

		if (query.kind === "label") {
			const want = query.text.toLowerCase();
			const matches = af.elements
				.filter((e) => {
					if (query.role && e.role.toLowerCase() !== query.role.toLowerCase()) return false;
					return (e.label ?? "").toLowerCase().includes(want);
				})
				.map((e, i) => {
					const exact = (e.label ?? "").toLowerCase() === want;
					return locatorFromElement(
						e,
						exact ? 0.95 : 0.7 - i * 0.05,
						`label match (${exact ? "exact" : "substring"})`,
					);
				});
			this.trace("locate", af.id, `kind=label want="${query.text}" hits=${matches.length}`);
			return matches.slice(0, 5);
		}

		if (query.kind === "role") {
			const want = query.role.toLowerCase();
			const ofRole = af.elements.filter((e) => e.role.toLowerCase() === want);
			if (typeof query.index === "number") {
				const el = ofRole[query.index];
				return el ? [locatorFromElement(el, 0.9, `role[${query.index}]`)] : [];
			}
			return ofRole.map((e, i) => locatorFromElement(e, 0.6 - i * 0.05, `role[${i}]`)).slice(0, 5);
		}

		if (query.kind === "describe") {
			// Vision fallback. Routes through describe() under perception tier check.
			const desc = await this.describe(af, `Find: ${query.text}`);
			const haystack = (desc.elements ?? []).map((e) => e.label.toLowerCase());
			const want = query.text.toLowerCase();
			for (let i = 0; i < haystack.length; i++) {
				if (haystack[i]?.includes(want)) {
					const el = af.elements.find((e) => (e.label ?? "").toLowerCase() === haystack[i]);
					if (el) {
						const loc = locatorFromElement(el, 0.55, `vision-described ${want}`);
						return [{ ...loc, source: "vision" }];
					}
				}
			}
			return [];
		}

		return [];
	}

	// -------------------------------------------------------------------------
	// describe (gated by perception:remote tier when provider is remote)
	// -------------------------------------------------------------------------

	async describe(frame: Frame, prompt = "Describe what is on screen."): Promise<Description> {
		const provider = this.opts.visionProvider;
		if (!provider) {
			throw new Error(
				"eyes/ax-native: describe() requires visionProvider in BackendOpts. Wire packages/providers and inject the chat call.",
			);
		}

		// Two-phase per spec §4.2 / §8.4 (closes #2508):
		//   1. Resolve the provider id WITHOUT calling the model.
		//   2. Check perception:remote tier on that id.
		//   3. Only on grant, call the inference. Frame bytes never leave the
		//      device when the tier denies.
		const req: VisionRequest = { frame, prompt };
		const resolvedProviderId = await provider.resolveProviderId(req);
		const check: PerceptionCheck = checkPerceptionRemote({
			sessionId: this.opts.sessionId,
			app: this.opts.app,
			provider: resolvedProviderId,
			calledFrom: "eyes.describe",
			actor: this.opts.actor,
		});
		if (!check.ok) {
			throw new Error(
				`eyes/ax-native: describe blocked by perception:remote tier (resolved provider="${resolvedProviderId}"). ${check.reason}`,
			);
		}

		const resp = await provider.describe(req);
		return {
			summary: resp.text,
			tokens: resp.tokens,
			model: `${resp.provider}/${resp.model}`,
			elements: undefined,
		};
	}

	// -------------------------------------------------------------------------
	// wait_for
	// -------------------------------------------------------------------------

	async wait_for(predicate: Predicate, opts: WaitOpts = {}): Promise<WaitResult> {
		const start = Date.now();
		const timeoutMs = opts.timeoutMs ?? 10_000;
		const pollMs = opts.pollMs ?? 350;

		while (Date.now() - start < timeoutMs) {
			const frame = await this.capture({ region: opts.region });
			const annotated = await this.annotate(frame);

			let matched: Locator | undefined;
			let success = false;

			switch (predicate.kind) {
				case "element_visible": {
					const hits = await this.locate(predicate.query, annotated);
					if (hits.length > 0) {
						matched = hits[0];
						success = true;
					}
					break;
				}
				case "element_gone": {
					const hits = await this.locate(predicate.query, annotated);
					if (hits.length === 0) success = true;
					break;
				}
				case "text_present": {
					const want = predicate.caseSensitive
						? predicate.text
						: predicate.text.toLowerCase();
					for (const el of annotated.elements) {
						const fields = [el.label ?? "", el.value ?? ""];
						for (const f of fields) {
							const hay = predicate.caseSensitive ? f : f.toLowerCase();
							if (hay.includes(want)) {
								matched = locatorFromElement(el, 0.6, `text_present "${predicate.text}"`);
								success = true;
								break;
							}
						}
						if (success) break;
					}
					break;
				}
				case "describe_matches": {
					try {
						const desc = await this.describe(frame, predicate.prompt);
						if (desc.summary && desc.summary.length > 0) success = true;
					} catch {
						// describe blocked by tier or provider missing; treat as not-yet-true.
					}
					break;
				}
			}

			if (success) {
				return { ok: true, matched, elapsedMs: Date.now() - start };
			}
			await new Promise((r) => setTimeout(r, pollMs));
		}
		return { ok: false, elapsedMs: Date.now() - start };
	}

	// -------------------------------------------------------------------------
	// diff
	// -------------------------------------------------------------------------

	async diff(a: Frame, b: Frame, opts: DiffOpts = {}): Promise<FrameDiff> {
		// Real perceptual diff (closes #2525). Returns a 0..1 similarity, real
		// changed regions in LOGICAL coords (raw px / scale), and an exact
		// pixelsDifferent count. Region coord conversion mirrors the v0 backend.
		if (!existsSync(a.path) || !existsSync(b.path)) {
			return {
				similarity: 0,
				regions: [{ x: 0, y: 0, width: a.width, height: a.height }],
				pixelsDifferent: a.width * a.height,
			};
		}

		const scale = a.scale > 0 ? a.scale : 1;
		const rawRegion = opts.region
			? {
					x: Math.round(opts.region.x * scale),
					y: Math.round(opts.region.y * scale),
					width: Math.round(opts.region.width * scale),
					height: Math.round(opts.region.height * scale),
				}
			: undefined;

		const result = await perceptualDiff(a.path, b.path, {
			region: rawRegion,
			threshold: opts.thresholdPx,
		});

		const regions = result.regions.map((r) => ({
			x: Math.floor(r.x / scale),
			y: Math.floor(r.y / scale),
			width: Math.ceil(r.width / scale),
			height: Math.ceil(r.height / scale),
		}));

		const pixelsDifferent = Math.round(result.pixelsDifferent / (scale * scale));

		return {
			similarity: result.similarity,
			regions,
			pixelsDifferent,
		};
	}

	// -------------------------------------------------------------------------
	// observe
	// -------------------------------------------------------------------------

	observe(handler: (e: ObservationEvent) => void, opts: ObserveOpts = {}): Disposable {
		const interval = opts.intervalMs ?? 1_000;
		const threshold = opts.thresholdSimilarity ?? 0.98;
		let prev: Frame | undefined;
		let stopped = false;

		const tick = async () => {
			if (stopped) return;
			try {
				const frame = await this.capture({ region: opts.region });
				if (prev) {
					const diff = await this.diff(prev, frame);
					if (diff.similarity < threshold) {
						handler({ at: frame.capturedAt, diff, frame });
						this.cache.invalidateMatching((_k, af) => af.displayId === frame.displayId);
					}
				}
				prev = frame;
			} catch {
				// swallow individual tick failures; observe is best-effort.
			} finally {
				if (!stopped) timer = setTimeout(tick, interval);
			}
		};

		let timer: ReturnType<typeof setTimeout> = setTimeout(tick, interval);
		this.trace("observe", "start", `interval=${interval}ms threshold=${threshold}`, "derive");

		return {
			dispose: () => {
				stopped = true;
				clearTimeout(timer);
				this.trace("observe", "stop", `disposed`, "derive");
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Backend descriptor.
// ---------------------------------------------------------------------------

async function probePermissions(opts: BridgeRunOpts): Promise<{
	ok: boolean;
	reason?: string;
}> {
	const r = await runBridge<{ permissions: BridgePermission[] }>(
		"permissions",
		{},
		opts,
	);
	if (!r.ok) return { ok: false, reason: r.reason };
	const required = r.data.permissions.filter((p) => p.isRequired);
	const missing = required.filter((p) => !p.isGranted);
	if (missing.length === 0) return { ok: true };
	const list = missing.map((p) => p.name).join(", ");
	const grant = missing.map((p) => p.grantInstructions).filter(Boolean).join(" | ");
	return { ok: false, reason: `missing entitlements: ${list}. Grant: ${grant}` };
}

/**
 * Direct factory for callers who need to inject visionProvider, sessionId,
 * app, or other ax-native-specific options.
 */
export function createAxNativeEyes(opts: AxNativeBackendOpts = {}): Eyes {
	return new AxNativeEyes(opts, true);
}

export const axNativeBackend: EyesBackend = {
	id: "ax-native",
	platforms: ["darwin"],
	minOSVersion: "13.0",
	available: async () => {
		if (process.platform !== "darwin") return false;
		const bin = resolveBridgeBinary();
		if (!bin) return false;
		const ok = await isBridgeAvailable();
		if (!ok) return false;
		const perms = await probePermissions({});
		return perms.ok;
	},
	create: (opts: BackendOpts = {}) => createAxNativeEyes(opts as AxNativeBackendOpts),
};

export { probePermissions };
