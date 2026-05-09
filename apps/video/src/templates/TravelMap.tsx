/**
 * TravelMap
 *
 * Wraps maplibre-gl with the Remotion contract:
 *  - delayRender on init, continueRender on 'load'
 *  - per-frame jumpTo (no flyTo / easeTo, those use real time)
 *  - no map.remove() cleanup (Remotion docs forbid it)
 *  - explicit width/height/absolute on the container
 *
 * Camera is a parametric rig: lat-lng + zoom + pitch + bearing all
 * keyframed by progress (0..1) along the durationInFrames timeline.
 *
 * No API token. Uses MapLibre demo tiles by default; swap STYLE_URL
 * for any free style URL (e.g. https://tiles.openfreemap.org/styles/positron).
 */

import maplibregl, { type Map as MaplibreMap, type StyleSpecification } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	AbsoluteFill,
	Easing,
	continueRender,
	delayRender,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";
import "maplibre-gl/dist/maplibre-gl.css";

export type LngLat = [number, number]; // [lng, lat]

export type CameraKeyframe = {
	/** progress 0..1 along the composition */
	at: number;
	center: LngLat;
	zoom: number;
	pitch?: number;
	bearing?: number;
};

export type TravelMapProps = {
	styleUrl?: string;
	/** Camera keyframes; the map interpolates between them every frame. */
	camera: CameraKeyframe[];
	/** Children render on top of the map (labels, end cards, clouds). */
	children?: React.ReactNode;
	/** Imperative hook fired once after the map loads, with the map instance. */
	onMapReady?: (map: MaplibreMap) => void;
	/** Set false to keep MapLibre interaction disabled (default: false). */
	interactive?: boolean;
};

const DEFAULT_STYLE = "https://demotiles.maplibre.org/style.json";

const cinematic = Easing.bezier(0.4, 0, 0.2, 1);

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
	// Handle antimeridian: pick the shorter way around.
	let dLng = b[0] - a[0];
	if (dLng > 180) dLng -= 360;
	if (dLng < -180) dLng += 360;
	let lng = a[0] + dLng * t;
	if (lng > 180) lng -= 360;
	if (lng < -180) lng += 360;
	return [lng, lerp(a[1], b[1], t)];
}

function sampleCamera(camera: CameraKeyframe[], progress: number): CameraKeyframe {
	if (camera.length === 0) {
		return { at: 0, center: [0, 0], zoom: 2, pitch: 0, bearing: 0 };
	}
	if (progress <= camera[0].at) return camera[0];
	if (progress >= camera[camera.length - 1].at) return camera[camera.length - 1];
	for (let i = 0; i < camera.length - 1; i++) {
		const a = camera[i];
		const b = camera[i + 1];
		if (progress >= a.at && progress <= b.at) {
			const span = b.at - a.at || 1;
			const localT = (progress - a.at) / span;
			const eased = cinematic(localT);
			return {
				at: progress,
				center: lerpLngLat(a.center, b.center, eased),
				zoom: lerp(a.zoom, b.zoom, eased),
				pitch: lerp(a.pitch ?? 0, b.pitch ?? 0, eased),
				bearing: lerp(a.bearing ?? 0, b.bearing ?? 0, eased),
			};
		}
	}
	return camera[camera.length - 1];
}

export const TravelMap: React.FC<TravelMapProps> = ({
	styleUrl = DEFAULT_STYLE,
	camera,
	children,
	onMapReady,
	interactive = false,
}) => {
	const ref = useRef<HTMLDivElement>(null);
	const { width, height, durationInFrames } = useVideoConfig();
	const frame = useCurrentFrame();

	const [loadHandle] = useState(() => delayRender("Loading map..."));
	// `map` IS read in render-affecting code: the per-frame camera-update effect
	// (below) depends on it, so useRef would not trigger that effect when the map
	// becomes available. Keep useState.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [map, setMap] = useState<MaplibreMap | null>(null);

	// First-load: create the map exactly once.
	// Intentionally no cleanup. Remotion forbids map.remove() here; the map
	// instance is owned by the Remotion frame lifecycle, not React unmount.
	// react-doctor-disable-next-line react-doctor/effect-needs-cleanup
	useEffect(() => {
		if (!ref.current) return;
		const initial = camera[0] ?? {
			center: [0, 0] as LngLat,
			zoom: 2,
			pitch: 0,
			bearing: 0,
		};
		const _map = new maplibregl.Map({
			container: ref.current,
			style: styleUrl as string | StyleSpecification,
			center: initial.center,
			zoom: initial.zoom,
			pitch: initial.pitch ?? 0,
			bearing: initial.bearing ?? 0,
			interactive,
			fadeDuration: 0,
			attributionControl: false,
		});
		_map.on("load", () => {
			_map.once("idle", () => {
				continueRender(loadHandle);
				setMap(_map);
				onMapReady?.(_map);
			});
		});
		// Intentionally no cleanup. Remotion forbids map.remove() here.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Per-frame camera update.
	useEffect(() => {
		if (!map) return;
		const frameHandle = delayRender(`Camera frame ${frame}`);
		const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
		});
		const cam = sampleCamera(camera, progress);
		map.jumpTo({
			center: cam.center,
			zoom: cam.zoom,
			pitch: cam.pitch ?? 0,
			bearing: cam.bearing ?? 0,
		});
		map.once("idle", () => continueRender(frameHandle));
	}, [map, frame, durationInFrames, camera]);

	const containerStyle: React.CSSProperties = useMemo(
		() => ({ width, height, position: "absolute", top: 0, left: 0 }),
		[width, height],
	);

	return (
		<AbsoluteFill>
			<div ref={ref} style={containerStyle} />
			{children}
		</AbsoluteFill>
	);
};

/**
 * Re-export the lerp helpers for templates that need world<->screen math.
 * @public
 */
export const _lerp = lerp;
/** @public */
export const _lerpLngLat = lerpLngLat;
