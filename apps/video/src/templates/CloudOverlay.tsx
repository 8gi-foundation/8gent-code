/**
 * CloudOverlay
 *
 * Soft drifting cloud layer rendered as a pure CSS/SVG overlay on top of
 * the map. No map dependency — composable with any TravelMap composition.
 *
 * Default palette is warm white over a subtle blue tint, no purple.
 */

import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

const OVERLAY_BASE_STYLE: React.CSSProperties = {
	position: "absolute",
	top: 0,
	left: 0,
	pointerEvents: "none",
	overflow: "hidden",
	mixBlendMode: "screen",
};

export type CloudOverlayProps = {
	/** Drift speed in screen pixels per second. */
	driftPxPerSec?: number;
	/** 0..1 base opacity. */
	intensity?: number;
	/** Number of cloud blobs. */
	count?: number;
	/** Random seed for blob layout. */
	seed?: number;
};

function mulberry32(a: number) {
	return () => {
		let t = (a += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const CloudOverlay: React.FC<CloudOverlayProps> = ({
	driftPxPerSec = 14,
	intensity = 0.45,
	count = 12,
	seed = 7,
}) => {
	const frame = useCurrentFrame();
	const { width, height, fps } = useVideoConfig();
	const rng = mulberry32(seed);

	const blobs = Array.from({ length: count }, (_, i) => ({
		x: rng() * width * 1.4 - width * 0.2,
		y: rng() * height,
		r: 120 + rng() * 240,
		speed: 0.6 + rng() * 0.8,
		phase: rng() * Math.PI * 2,
		seedOpacity: 0.5 + rng() * 0.5,
	}));

	const t = frame / fps;

	// Slow opacity breathing for atmosphere.
	const breathe = interpolate(Math.sin(t * 0.6), [-1, 1], [0.85, 1.05]);

	return (
		<div style={{ ...OVERLAY_BASE_STYLE, width, height }}>
			<svg
				width={width}
				height={height}
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label="Drifting cloud overlay"
			>
				<title>Drifting cloud overlay</title>
				<defs>
					<radialGradient id="cloudGrad" cx="50%" cy="50%" r="50%">
						<stop offset="0%" stopColor="#FEF3C7" stopOpacity="0.85" />
						<stop offset="60%" stopColor="#FFFFFF" stopOpacity="0.45" />
						<stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
					</radialGradient>
					<filter id="cloudBlur">
						<feGaussianBlur stdDeviation="22" />
					</filter>
				</defs>
				<g filter="url(#cloudBlur)" opacity={intensity * breathe}>
					{/* blobs is generated from a deterministic seeded RNG each render; the array is the same length and in the same order every frame, never reordered or filtered. Index keys are stable. */}
					{blobs.map((b, i) => {
						const drift = (t * driftPxPerSec * b.speed) % (width + 600);
						const cx = ((b.x + drift) % (width + 600)) - 200;
						const cy = b.y + Math.sin(t * 0.4 + b.phase) * 20;
						return (
							// react-doctor-disable-next-line react-doctor/no-array-index-as-key
							<circle
								key={i}
								cx={cx}
								cy={cy}
								r={b.r}
								fill="url(#cloudGrad)"
								opacity={b.seedOpacity}
							/>
						);
					})}
				</g>
			</svg>
		</div>
	);
};
