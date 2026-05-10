# 8gent Eyes - Perception Capability Spec

Status: DRAFT (RFC). Issue: 8gi-foundation/8gent-code#2496.

## 1. Why eyes exists

The body-parts taxonomy (hands, eyes, voice, browser-harness, email) is the public spine of the 8gent product. `packages/hands` already ships motor primitives (click, type, scroll, drag, hover, press, clipboard, window enumeration) plus a screenshot call kept there for historical reasons. As we add real perception primitives - find an element by description, run a vision model on a frame, wait until the screen reaches some state, diff two frames - they need a home.

`eyes` is the perception layer. Hands act, eyes perceive. The split is the same one a human nervous system makes: motor cortex vs visual cortex. This spec defines the eyes contract; it does not yet wire any backend.

## 2. Scope of this spec

In scope:

- The Eyes interface (capture, annotate, locate, describe, wait_for, diff, observe).
- Frame and Locator types that eyes produces and hands consumes.
- Permission / consent model.
- Failover chain across backends.
- Headless `--intent` parity per the dispatch-everywhere rule.

Out of scope (explicit non-goals for this spec):

- Backend implementation. The native AX backend rationale lives in `EYES-BACKEND-AX-NATIVE.md`; the adapter ships in `packages/eyes/backends/ax-native.ts`.
- Migrating `hands.screenshot()` into eyes. Acknowledged as duplication, tracked separately. Eyes will initially call into hands for capture so we ship a working contract without touching hands.
- Tool registration in `packages/eight/tools.ts` or system-prompt edits. Contract first; tool surface follows once a backend exists.

## 3. The contract

```ts
export interface Eyes {
	readonly id: string;
	readonly available: boolean;
	readonly backend: string;

	// Capture a still frame from the focused display (per §8.2). Pass
	// `displayId: "all"` to use captureAll() instead.
	capture(opts?: CaptureOpts): Promise<Frame>;

	// Capture one frame per attached display. Never a stitched composite -
	// stitching breaks logical-coord assumptions across mixed-DPI displays.
	captureAll(opts?: Omit<CaptureOpts, "displayId">): Promise<Frame[]>;

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
	displayId?: number | "all" | "primary";  // default: focused display per §8.2
	region?: Region;
	includeCursor?: boolean;
	format?: "png" | "jpeg";
}

export interface Frame {
	id: string;
	path: string;          // file on disk, for downstream consumers
	buffer?: Buffer;       // optional in-memory copy
	width: number;         // logical (DPI-independent) pixels per §8.1
	height: number;        // logical
	displayId: number;
	capturedAt: number;    // epoch ms
	scale: number;         // backing scale factor (2 on retina). raw_pixels = width * scale.
	platform: "darwin" | "win32" | "linux";  // for cross-platform locator dispatch per §8.5
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

Perception is sensitive: a screenshot of the screen can contain anything. The contract enforces four rules.

1. **Base capability tier.** Local eyes operations (`capture`, `annotate`, `locate` via AX, `describe` via local vision, `wait_for`, `diff`, `observe`) require the same capability tier as hands: `computer-use` enabled, user-confirmed. The control plane gates this; eyes does not invent its own permission UI.
2. **Egress-gated tier for remote vision (resolve-first contract).** A separate `perception:remote` tier is required when, and only when, the resolved provider for a `describe()` or `locate({kind:"describe"})` call sends frame bytes off-device. The gate fires on actual data egress at runtime, not on the active backend's identity, because the same call can land on a local or remote model depending on failover state.

   The `VisionProvider` interface enforces this with a two-phase contract:

   ```ts
   interface VisionProvider {
     resolveProviderId(req: VisionRequest): Promise<string>;  // no inference call
     describe(req: VisionRequest): Promise<VisionResponse>;   // actual inference
   }
   ```

   The eyes backend MUST call `resolveProviderId()` first, run the tier check on that id, and ONLY then call `describe()`. Frame bytes never leave the device when the tier denies. Implementations MUST cache the resolution so the inference call hits the same provider that was tier-checked.

   Consent surface: `[Once] [This session] [Always for this app]`. While `perception:remote` is active, a persistent header indicator stays visible (small amber dot, never red, never violet) per the accessibility-primitives rule that state must be visible without hover.
3. **OS-level entitlements live with the backend.** macOS Screen Recording and Accessibility permissions are owned by the backend (today: the bundled native AX bridge). The Eyes interface exposes an `available` boolean and a `backend` name; if `available` is false, operations return `{ ok: false }` rather than throwing.
4. **Audit trail.** Every capture, locate, and describe call writes to the trace store with frame id, backend, timestamp, calling tool, and (for `describe`) the resolved model destination. Eyes never silently reads the screen.

Eyes never:

- Captures continuously without an active `observe()` subscription.
- Sends frames off-device without `perception:remote` tier active for the current session/app.
- Stores frames longer than the session, except in the trace store under the same retention policy as other tool traces.

## 5. Failover chain

Mirroring the provider/failover pattern in `packages/providers/failover.ts`:

1. **Local AX-first.** Backend that uses macOS Accessibility APIs for `annotate` and `locate`. Vision is opt-in per call.
2. **Local vision fallback.** When AX fails (e.g. Electron app with no AX tree), call a local vision model via the existing 8gent provider chain to identify elements from the frame. Stays inside `computer-use` tier.
3. **Remote VLM.** If local vision is unavailable or low-confidence, fall back to a remote vision-capable model through the configured provider chain. Triggers the `perception:remote` capability tier per §4.2; the call returns `{ ok: false, reason: "perception:remote not granted" }` if the tier is not active.

Eyes does not own the model. Eyes asks the existing provider chain for `vision` capability. This means new vision models become available to eyes the moment they are registered with the provider registry. The egress-gating in §4.2 examines the resolved provider per call, so a `describe()` call that the failover chain happens to satisfy locally never trips `perception:remote`.

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
	readonly id: string;            // "ax-native" | "remote-vlm" | ...
	readonly platforms: Array<"darwin" | "linux" | "win32">;
	readonly minOSVersion?: string;
	readonly available: () => Promise<boolean>;
	readonly create: (opts?: BackendOpts) => Eyes;
}
```

Backends register with a small registry similar to `packages/providers/registry`. The active backend is selected by the failover chain at session start; the user can pin a specific backend via config.

## 8. Decisions

The five questions previously parked here as RFC have been answered. All are binding for v0; revisit only with a spec amendment.

### 8.1 Coordinate space → logical points

Eyes returns logical (DPI-independent) points everywhere a coordinate appears (`Point`, `Region`, `bbox`, `Frame.width/height`). Hands invokes `cliclick` with logical coords (`packages/hands/index.ts:307`), so any physical-pixel value would have to be divided by the display backing scale before reaching hands. Backends MUST normalise: divide raw PNG pixel dimensions by the display's backing scale before populating `Frame` and `AnnotatedElement`. `Frame.scale: number` is exposed so vision backends that need raw pixels can recover them (`raw_pixels = width * scale`), but the public contract stays logical. This keeps eyes → hands a zero-conversion handoff and matches accessibility-zoom users' mental model (a button at `400, 300` stays at `400, 300` when they zoom).

### 8.2 Multi-display → focused display by default; never silent stitching

Default `capture()` targets the display containing the focused window, not display 0. The screen the user is looking at is the screen the agent should see. `CaptureOpts.displayId` accepts `number | "all" | "primary"`; `"all"` routes to `captureAll(): Promise<Frame[]>` which returns one `Frame` per display. Stitched composites are explicitly not supported because they break logical-coord assumptions across mixed-DPI displays, produce element bboxes no AX walker will produce, and have no coherent reading order for screen-reader and ADHD-mode users.

### 8.3 Annotation cache → 2s TTL, 16-frame LRU, region-keyed, observe-invalidated

Backends MUST cache `annotate()` results, keyed by `(frame.id, displayId, region)`. On cache hit, `locate()` skips the AX walk entirely. Bounds: TTL 2s (any user input or animation invalidates assumptions; longer TTLs invite stale-locator clicks, which is the worst possible failure mode for hands) and a 16-frame LRU cap (annotated AX trees are 10 to 200 KB on rich apps; 16 covers a typical multi-step plan window). The cache MUST auto-invalidate on any `observe()` event whose `diff.similarity` is below the configured threshold. Cache lives in-process inside the backend, never in `packages/eyes` (the registry stays stateless).

### 8.4 Vision-model gate → separate `perception:remote` tier, gated on data egress at runtime

`describe()` and `locate({kind:"describe"})` route through the provider chain (§5). The capability tier upgrade fires when, and only when, the resolved provider for that call sends frame bytes off-device. Local VLM (8gent provider, Apple Foundation, Ollama vision) stays at the plain `computer-use` tier already required for `capture()` - the user has already consented to the screen being read locally. Remote VLM requires the `perception:remote` tier with the consent UX in §4.2. Gating on backend identity would be wrong because the same `describe()` call can land on either tier depending on failover state at runtime; gating on the actual destination of the bytes is what protects the local-first brand promise.

### 8.5 Cross-platform path → macOS → Windows → Linux X11 → Linux Wayland

Backend implementation order:

1. **macOS** (bundled native AX bridge). v0 target.
2. **Windows** - UI Automation (UIA) COM API + `BitBlt`. UIA gives a real accessibility tree comparable to AX, and the install base justifies it.
3. **Linux X11** - AT-SPI2 + `xdotool`/`scrot`. Universal click path exists.
4. **Linux Wayland** - AT-SPI2 + per-compositor `xdg-desktop-portal` screencast. No portable click backend; locator vision fallback (`LocatorQuery.kind: "describe"`) is the safety valve when the AT-SPI tree returns nothing.

Required interface change (already applied in §3.1): `Frame.platform: "darwin" | "win32" | "linux"` for cross-platform locator dispatch, and `AnnotatedElement.id` is opaque/backend-scoped (the spec already implied this; now made explicit). On non-Mac platforms today, eyes returns `available: false`; the /abilities humanoid robot shows the eyes ability as outlined-not-filled (not greyed-out; greyed-out reads as broken, outlined reads as roadmap), with a tooltip linking to the platform tracking issue. Non-Mac users see roadmap, not absence.

## 9. Migration of hands.screenshot

Eyes ships first as a sibling to hands, with eyes calling into `hands.screenshot()` for the `capture()` impl. After the first backend lands, a follow-up issue migrates the screenshot impl to eyes and reduces hands to motor only. This avoids touching hands in the same PR as the contract.

## 10. References

- `packages/hands/index.ts` - current motor primitives.
- `packages/computer/bridge.ts` - current screenshot consumer.
- `docs/decks/capabilities-vs-claude-suite/deck.md` - body-parts taxonomy.
- `docs/specs/EYES-BACKEND-PEEKABOO.md` - first backend rationale.
