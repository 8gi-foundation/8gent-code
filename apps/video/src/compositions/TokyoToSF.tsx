/**
 * TokyoToSF
 *
 * Canonical demo composition. Tokyo (HND) -> San Francisco (SFO).
 *
 * Beats (assumes 240 frames at 30 fps = 8 seconds):
 *  0-60    Open  : tight on Tokyo, subtle pitch + bearing sweep, label rises.
 *  60-120  Reveal: pull back to reveal Asia + Pacific, trail starts drawing.
 *  120-200 Travel: camera tracks along the great circle with lookahead.
 *  200-240 Settle: ease into SF framing, end card springs in.
 *
 * To use:
 *   import { TokyoToSF } from './TokyoToSF';
 *   In your Root.tsx:
 *     <Composition id="TokyoToSF" component={TokyoToSF}
 *       durationInFrames={240} fps={30} width={1920} height={1080} />
 *
 * Render:
 *   bunx remotion render src/index.ts TokyoToSF out.mp4 --gl=angle --concurrency=1
 *
 * NOTE: This file has not been frame-rendered during authoring. If imports
 * fail, the most likely fix is adjusting the relative path to ../templates.
 */

import type maplibregl from "maplibre-gl";
import { useState } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { CityLabel } from "../templates/CityLabel";
import { CloudOverlay } from "../templates/CloudOverlay";
import { EndCard } from "../templates/EndCard";
import { FlightPath, pointAlongGreatCircle } from "../templates/FlightPath";
import { type CameraKeyframe, type LngLat, TravelMap } from "../templates/TravelMap";

const TOKYO: LngLat = [139.7798, 35.5494]; // Haneda
const SF: LngLat = [-122.379, 37.6213]; // SFO

// Use OpenFreeMap's positron style for a clean cinematic look. Falls back
// to MapLibre demo tiles automatically if positron is unreachable in your
// render environment.
const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

export const TokyoToSF: React.FC = () => {
	const frame = useCurrentFrame();
	const [map, setMap] = useState<maplibregl.Map | null>(null);

	// Camera keyframes by progress (0..1). Beats map to 0/0.25/0.5/0.83/1.
	// Mid-route, we sample the great circle so the camera tracks the path
	// with a small lookahead (we use 0.6 for "ahead of head" framing).
	const midRoute = pointAlongGreatCircle(TOKYO, SF, 0.55);
	const lateRoute = pointAlongGreatCircle(TOKYO, SF, 0.78);

	const camera: CameraKeyframe[] = [
		{ at: 0.0, center: TOKYO, zoom: 8.4, pitch: 55, bearing: -10 },
		{ at: 0.25, center: TOKYO, zoom: 5.2, pitch: 45, bearing: 8 },
		{ at: 0.5, center: midRoute, zoom: 3.4, pitch: 40, bearing: 22 },
		{ at: 0.83, center: lateRoute, zoom: 4.6, pitch: 50, bearing: 18 },
		{ at: 1.0, center: SF, zoom: 8.8, pitch: 55, bearing: 8 },
	];

	return (
		<AbsoluteFill style={{ background: "#0B1E3F" }}>
			<TravelMap styleUrl={STYLE_URL} camera={camera} onMapReady={setMap}>
				<FlightPath
					map={map}
					from={TOKYO}
					to={SF}
					drawRange={[0.25, 0.92]}
					color="#F59E0B"
					glowColor="#FCD34D"
				/>
				<CityLabel
					map={map}
					position={TOKYO}
					label="Tokyo"
					sublabel="HND"
					enterFrame={10}
					exitFrame={120}
				/>
				<CityLabel map={map} position={SF} label="San Francisco" sublabel="SFO" enterFrame={150} />
				<CloudOverlay intensity={0.42} count={14} driftPxPerSec={12} />
				<EndCard
					enterFrame={205}
					title="San Francisco"
					subtitle="Welcome to the Bay"
					meta="LetsFG | Flight Booked"
					brandMark="LetsFlyGuru"
				/>
			</TravelMap>
		</AbsoluteFill>
	);
};
