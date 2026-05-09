# 8gent Eyes — Perception Capability Spec

Status: DRAFT (RFC). Issue: 8gi-foundation/8gent-code#2496.

## 1. Why eyes exists

The body-parts taxonomy (hands, eyes, voice, browser-harness, email) is the public spine of the 8gent product. `packages/hands` already ships motor primitives (click, type, scroll, drag, hover, press, clipboard, window enumeration) plus a screenshot call kept there for historical reasons. As we add real perception primitives — find an element by description, run a vision model on a frame, wait until the screen reaches some state, diff two frames — they need a home.

`eyes` is the perception layer. Hands act, eyes perceive. The split is the same one a human nervous system makes: motor cortex vs visual cortex. This spec defines the eyes contract; it does not yet wire any backend.

## 2. Scope of this spec

In scope:

- The Eyes interface (capture, annotate, locate, describe, wait_for, diff, observe).
- Frame and Locator types that eyes produces and hands consumes.
- Permission / consent model.
- Failover chain across backends.
- Headless `--intent` parity per the dispatch-everywhere rule.

Out of scope (explicit non-goals for this spec):

- Backend implementation. The Peekaboo backend rationale lives in `EYES-BACKEND-PEEKABOO.md`; the actual adapter is a follow-up PR.
- Migrating `hands.screenshot()` into eyes. Acknowledged as duplication, tracked separately. Eyes will initially call into hands for capture so we ship a working contract without touching hands.
- Tool registration in `packages/eight/tools.ts` or system-prompt edits. Contract first; tool surface follows once a backend exists.

## 3. The contract

```ts
export interface Eyes {
	readonly id: string;
	readonly available: boolean;
	readonly backend: string;

	// Capture a still frame. The lowest level operation.
	capture(opts?: CaptureOpts): Promise<Frame>;

	// Annotate a frame with element IDs by walking the AX tree (or a vision
	// fallback). Subsequent locate/click calls can refer to elements by id.
	annotate(frame: Frame): Promise<AnnotatedFrame>;

	// Find an element by natural-language description, accessibility role,
	// label, or a vision-model query. Returns one or more candidate locators.
	locate(query: LocatorQuery, frame?: AnnotatedFrame): Promise<Locator[]>;

	// Run a vision model over a frame (or a region) and return a structured
	// description. Used for "what's on screen?" and verification steps.
	describe(frame: Frame, prompt?: string): Promise<Description>;

	// Block until a predicate over the live screen becomes true. Polls at the
	// backend's natural rate. Times out cleanly.
	wait_for(predicate: Predicate, opts?: WaitOpts): Promise<WaitResult>;

	// Compare two frames. Returns changed regions and a similarity score.
	// Useful for "did anything change after my last action?" loops.
	diff(a: Frame, b: Frame, opts?: DiffOpts): Promise<FrameDiff>;

	// Continuous observation. Emits events when the screen changes
	// materially (above some threshold). Backend may implement via polling
	// or a native API. Caller stops with the returned dispose function.
	observe(handler: (e: ObservationEvent) => void, opts?: ObserveOpts): Disposable;
}
```

### 3.1 Types

```ts
export interface CaptureOpts {
	displayId?: number;
	region?: Region;
	includeCursor?: boolean;
	format?: "png" | "jpeg";
}

export interface Frame {
	id: string;
	path: string;          // file on disk, for downstream consumers
	buffer?: Buffer;       // optional in-memory copy
	width: number;
	height: number;
	displayId: number;
	capturedAt: number;    // epoch ms
}

export interface AnnotatedFrame extends Frame {
	elements: AnnotatedElement[];
}

export interface AnnotatedElement {
	id: string;            // backend-stable element id (e.g. "B12")
	role: string;          // AX role: button, textfield, link, etc.
	label?: string;        // accessible label
	value?: string;        // current value (for fields)
	bbox: Region;
	enabled: boolean;
	app?: string;          // bundle id
	window?: string;       // window title
}

export type LocatorQuery =
	| { kind: "id"; id: string }
	| { kind: "label"; text: string; role?: string }
	| { kind: "role"; role: string; index?: number }
	| { kind: "describe"; text: string }       // vision-model fallback
	| { kind: "coords"; x: number; y: number };

export interface Locator {
	target: { id: string } | { point: Point };
	confidence: number;    // 0..1
	source: "ax" | "vision" | "coords";
	bbox?: Region;
	rationale?: string;    // for debug / audit
}

export interface Description {
	summary: string;
	elements?: Array<{ role: string; label: string; bbox?: Region }>;
	tokens?: number;
	model?: string;
}

export type Predicate =
	| { kind: "element_visible"; query: LocatorQuery }
	| { kind: "element_gone"; query: LocatorQuery }
	| { kind: "text_present"; text: string; caseSensitive?: boolean }
	| { kind: "describe_matches"; prompt: string };  // vision-model judged

export interface WaitOpts {
	timeoutMs?: number;     // default 10_000
	pollMs?: number;        // backend default
	region?: Region;
}

export interface WaitResult {
	ok: boolean;
	matched?: Locator;
	elapsedMs: number;
}

export interface FrameDiff {
	similarity: number;      // 0..1, 1 = identical
	regions: Region[];       // changed bounding boxes
	pixelsDifferent: number;
}

export interface ObservationEvent {
	at: number;
	diff: FrameDiff;
	frame: Frame;
}

export interface ObserveOpts {
	thresholdSimilarity?: number;  // emit when below this. default 0.98
	intervalMs?: number;
	region?: Region;
}

export type Region = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Disposable = { dispose: () => void };
```

### 3.2 Hands integration

Hands today takes raw `Point` coordinates. With eyes, the natural pattern becomes:

```ts
const frame = await eyes.capture();
const annotated = await eyes.annotate(frame);
const [target] = await eyes.locate({ kind: "label", text: "Sign in" }, annotated);
if (target?.target && "point" in target.target) {
	hands.click(target.target.point);
}
```

Hands does not depend on eyes. Eyes does not depend on hands at type level. The agent loop wires them together. This keeps the body-parts independent and individually testable.

## 4. Permission and consent

Perception is sensitive: a screenshot of the screen can contain anything. The contract enforces three rules.

1. **Explicit capability tier.** Eyes operations require the same capability tier as hands: `computer-use` enabled, user-confirmed. The control plane gates this; eyes does not invent its own permission UI.
2. **OS-level entitlements live with the backend.** macOS Screen Recording and Accessibility permissions are owned by the backend (e.g. Peekaboo, native AVFoundation). The Eyes interface exposes a `available` boolean and a `backend` name; if `available` is false, operations return `{ ok: false }` rather than throwing.
3. **Audit trail.** Every capture, locate, and describe call writes to the trace store with frame id, backend, timestamp, and the calling tool. Eyes never silently reads the screen.

Eyes never:

- Captures continuously without an active `observe()` subscription.
- Sends frames off-device unless the active backend is a remote VLM and the user has consented to that backend.
- Stores frames longer than the session, except in the trace store under the same retention policy as other tool traces.

## 5. Failover chain

Mirroring the provider/failover pattern in `packages/providers/failover.ts`:

1. **Local AX-first.** Backend that uses macOS Accessibility APIs for `annotate` and `locate`. Vision is opt-in per call.
2. **Local vision fallback.** When AX fails (e.g. Electron app with no AX tree), call a local vision model via the existing 8gent provider to identify elements from the frame.
3. **Remote VLM.** If local vision is unavailable or low-confidence, fall back to a remote vision-capable model through the configured provider chain. Requires user consent (rule 4.2 above).

Eyes does not own the model. Eyes asks the existing provider chain for `vision` capability. This means new vision models become available to eyes the moment they are registered with the provider registry.

## 6. Headless parity

Per the dispatch-everywhere hard rule, eyes ships a headless surface from day one:

```
8gent-eyes --intent "find the Sign in button on the active window" --json
8gent-eyes --intent "describe the screen" --json
8gent-eyes --intent "wait until a Save dialog appears" --timeout 30s --json
```

The CLI is a thin wrapper around the Eyes interface, deterministic, JSON-out by default, no telemetry side effects beyond the audit trace. Per the AgentCLIDesign rules (token-cheap, deterministic, no telemetry, headless parity).

## 7. Backend adapter shape

```ts
export interface EyesBackend {
	readonly id: string;            // "peekaboo" | "ax-native" | "remote-vlm" | ...
	readonly platforms: Array<"darwin" | "linux" | "win32">;
	readonly minOSVersion?: string;
	readonly available: () => Promise<boolean>;
	readonly create: (opts?: BackendOpts) => Eyes;
}
```

Backends register with a small registry similar to `packages/providers/registry`. The active backend is selected by the failover chain at session start; the user can pin a specific backend via config.

## 8. Open questions (RFC)

These are explicitly unresolved and want comment before the first backend lands.

1. **Coordinate space.** Should eyes return logical points (DPI-independent) or physical pixels? Hands today uses `cliclick` which is logical. Suggested: logical. Document the choice in the `Frame` type.
2. **Multi-display.** Should `capture()` default to the focused display, the primary display, or all displays stitched? Suggested: focused, with `displayId` to override.
3. **Annotation cache.** Should `annotate()` results be cached against a frame id so subsequent `locate()` calls do not re-walk the AX tree? Suggested: yes, with TTL and a cap.
4. **Vision-model gate.** Should `describe()` calls require an additional capability tier above plain perception? Suggested: yes when the active backend is remote.
5. **Cross-platform path.** macOS-first is fine for v0. Linux (X11/Wayland) and Windows backends are noted in the registry but not built. The interface should be platform-neutral; the only mac-specific surface is element IDs from the AX tree.

## 9. Migration of hands.screenshot

Eyes ships first as a sibling to hands, with eyes calling into `hands.screenshot()` for the `capture()` impl. After the first backend lands, a follow-up issue migrates the screenshot impl to eyes and reduces hands to motor only. This avoids touching hands in the same PR as the contract.

## 10. References

- `packages/hands/index.ts` — current motor primitives.
- `packages/computer/bridge.ts` — current screenshot consumer.
- `docs/decks/capabilities-vs-claude-suite/deck.md` — body-parts taxonomy.
- `docs/specs/EYES-BACKEND-PEEKABOO.md` — first backend rationale.
