/**
 * ThinkingVisualizer - Procedural canvas inside the Thinking box.
 *
 * Composes 6 operator modules in rotation. Each operator reads a shared
 * 8-dimension param vector and a monotonic frame tick. The label
 * (default "Thinking...") stays centred; operators receive an `avoid`
 * region so they render around it.
 *
 * Crossfade: when the active operator swaps, we render the outgoing
 * operator dimmed (~0.3 brightness) for the first ~600ms, then the
 * incoming brightens up. Ink can't compose layers, so we render whichever
 * operator the phase indicates - the brightness modulates the overall
 * intensity of glyphs/colours.
 *
 * Settings: reads `~/.8gent/settings.json` via `@8gent/settings` for
 *   `ui.thinkingVisualiser.{enabled, operatorRotationMs, boredomThresholdMs}`.
 * Falls back to defaults if the package or settings shape isn't there.
 *
 * Token-stream input: callers can call the exported
 *   `pushVisualiserToken(token)` to perturb the param vector. The
 *   composer subscribes to a singleton store so the agent loop never
 *   has to thread props through.
 */

import { Box, Text } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	DEFAULT_PARAMS,
	hashToken,
	logBoredomEvent,
	mutateForBoredom,
	perturbFromToken,
	type ParamVector,
} from "../lib/visualiser-params.js";
import { sampleAmber } from "../lib/amber-palette.js";
import { loadSettings } from "../../../../packages/settings/index.js";
import { NoiseField } from "./operators/NoiseField.js";
import { ParticleDrift } from "./operators/ParticleDrift.js";
import { GradientSpectrum } from "./operators/GradientSpectrum.js";
import { RuneDance } from "./operators/RuneDance.js";
import { OctagonOrbit } from "./operators/OctagonOrbit.js";
import { GlyphRain } from "./operators/GlyphRain.js";
import type { OperatorComponent, OperatorName } from "./operators/types.js";

interface VisualiserSettings {
	enabled: boolean;
	operatorRotationMs: number;
	boredomThresholdMs: number;
}

const FALLBACK_SETTINGS: VisualiserSettings = {
	enabled: true,
	operatorRotationMs: 8000,
	boredomThresholdMs: 30000,
};

function loadVisualiserSettings(): VisualiserSettings {
	try {
		const s = loadSettings();
		const v = s.ui?.thinkingVisualiser as Partial<VisualiserSettings> | undefined;
		return {
			enabled: typeof v?.enabled === "boolean" ? v.enabled : FALLBACK_SETTINGS.enabled,
			operatorRotationMs:
				typeof v?.operatorRotationMs === "number" && v.operatorRotationMs > 500
					? v.operatorRotationMs
					: FALLBACK_SETTINGS.operatorRotationMs,
			boredomThresholdMs:
				typeof v?.boredomThresholdMs === "number" && v.boredomThresholdMs > 1000
					? v.boredomThresholdMs
					: FALLBACK_SETTINGS.boredomThresholdMs,
		};
	} catch {
		return FALLBACK_SETTINGS;
	}
}

// ── Singleton store for token perturbation ──────────────────────────
// The agent loop emits tokens, but it shouldn't have to thread props
// through the entire React tree. Keep a tiny pub/sub here.

interface VisualiserStore {
	params: ParamVector;
	lastActivityAt: number;
	lastTokenHash: number;
	subscribers: Set<() => void>;
}

const store: VisualiserStore = {
	params: { ...DEFAULT_PARAMS },
	lastActivityAt: Date.now(),
	lastTokenHash: 0,
	subscribers: new Set(),
};

function notify() {
	for (const cb of store.subscribers) cb();
}

/** Hook into a token stream. Call this when the agent emits a token. */
export function pushVisualiserToken(token: string): void {
	if (!token) return;
	store.params = perturbFromToken(store.params, token);
	store.lastActivityAt = Date.now();
	store.lastTokenHash = hashToken(token);
	notify();
}

/** Force a boredom mutation - exposed for tests / debugging. */
export function forceBoredomMutation(seed: number, nextOperator: OperatorName, prevOperator: OperatorName): void {
	const previous = store.params;
	const next = mutateForBoredom(previous, seed);
	store.params = next;
	logBoredomEvent({
		timestamp: Date.now(),
		seed,
		previous,
		next,
		previousOperator: prevOperator,
		nextOperator,
	});
	notify();
}

// ── Operator registry ───────────────────────────────────────────────

const OPERATORS: Record<OperatorName, OperatorComponent> = {
	NoiseField,
	ParticleDrift,
	GradientSpectrum,
	RuneDance,
	OctagonOrbit,
	GlyphRain,
};

const OPERATOR_ORDER: OperatorName[] = [
	"NoiseField",
	"ParticleDrift",
	"GradientSpectrum",
	"RuneDance",
	"OctagonOrbit",
	"GlyphRain",
];

// ── Component ──────────────────────────────────────────────────────

interface ThinkingVisualizerProps {
	label?: string;
	width?: number;
	height?: number;
	/** When false, the visualiser is hidden entirely. */
	active?: boolean;
}

export function ThinkingVisualizer({
	label = "Thinking...",
	width: widthOverride,
	height: heightOverride,
	active = true,
}: ThinkingVisualizerProps): React.ReactElement | null {
	const settingsRef = useRef<VisualiserSettings>(loadVisualiserSettings());
	const settings = settingsRef.current;

	const [tick, setTick] = useState(0);
	const [opIdx, setOpIdx] = useState(0);
	const [, setStoreVersion] = useState(0);
	const lastSwapRef = useRef<number>(Date.now());
	const lastBoredomRef = useRef<number>(Date.now());
	const crossfadeStartRef = useRef<number>(0);

	// Subscribe to token-store changes
	useEffect(() => {
		const cb = () => setStoreVersion((v) => v + 1);
		store.subscribers.add(cb);
		return () => {
			store.subscribers.delete(cb);
		};
	}, []);

	// Animation tick + rotation + boredom
	useEffect(() => {
		if (!active || !settings.enabled) return;
		const interval = setInterval(() => {
			const now = Date.now();
			setTick((t) => t + 1);

			// Rotate operators
			if (now - lastSwapRef.current >= settings.operatorRotationMs) {
				lastSwapRef.current = now;
				crossfadeStartRef.current = now;
				setOpIdx((i) => (i + 1) % OPERATOR_ORDER.length);
			}

			// Boredom mutation
			if (now - store.lastActivityAt >= settings.boredomThresholdMs && now - lastBoredomRef.current >= 5000) {
				lastBoredomRef.current = now;
				const prevName = OPERATOR_ORDER[opIdx]!;
				const nextIdx = (opIdx + 1 + Math.floor(Math.random() * (OPERATOR_ORDER.length - 1))) % OPERATOR_ORDER.length;
				const nextName = OPERATOR_ORDER[nextIdx]!;
				const seed = (now ^ store.lastTokenHash) >>> 0;
				const previous = store.params;
				const next = mutateForBoredom(previous, seed);
				store.params = next;
				logBoredomEvent({
					timestamp: now,
					seed,
					previous,
					next,
					previousOperator: prevName,
					nextOperator: nextName,
				});
				crossfadeStartRef.current = now;
				setOpIdx(nextIdx);
				lastSwapRef.current = now;
			}
		}, 120);
		return () => clearInterval(interval);
	}, [active, settings.enabled, settings.operatorRotationMs, settings.boredomThresholdMs, opIdx]);

	if (!active || !settings.enabled) return null;

	const width = Math.max(20, Math.min(120, widthOverride ?? 80));
	const height = Math.max(3, Math.min(12, heightOverride ?? 6));

	// Crossfade brightness curve
	const sinceSwap = Date.now() - crossfadeStartRef.current;
	const fadeMs = 600;
	const brightness = sinceSwap < fadeMs ? 0.3 + (sinceSwap / fadeMs) * 0.7 : 1;

	// Split the canvas into top half + label row + bottom half so the
	// label sits on a dedicated row. Each half gets its own avoid region
	// (none) so operators fill cleanly.
	const labelRow = Math.floor(height / 2);
	const topHeight = labelRow;
	const bottomHeight = Math.max(0, height - labelRow - 1);

	const Op = OPERATORS[OPERATOR_ORDER[opIdx]!];

	return (
		<Box flexDirection="column" width={width}>
			{topHeight > 0 && (
				<Op
					width={width}
					height={topHeight}
					params={store.params}
					tick={tick}
					brightness={brightness}
				/>
			)}
			<Box width={width} justifyContent="center">
				<Text bold color={sampleAmber(0.75)}>
					{` ${label} `}
				</Text>
			</Box>
			{bottomHeight > 0 && (
				<Op
					width={width}
					height={bottomHeight}
					params={store.params}
					tick={tick + 7}
					brightness={brightness}
				/>
			)}
		</Box>
	);
}

export default ThinkingVisualizer;
