/**
 * CityLabel
 *
 * Spring-driven label anchored to a lat-lng. Projects world coordinates
 * to screen pixels using map.project() each frame, so the label stays
 * pinned during camera moves.
 *
 * Renders as a regular DOM overlay (not a MapLibre symbol layer) because
 * we want full control of typography and motion via React + CSS.
 */

import type maplibregl from "maplibre-gl";
import { useEffect, useState } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { LngLat } from "./TravelMap";

const LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Inter", sans-serif';

const LABEL_WRAPPER_BASE_STYLE: React.CSSProperties = {
	position: "absolute",
	pointerEvents: "none",
	fontFamily: LABEL_FONT_FAMILY,
	textAlign: "center",
	whiteSpace: "nowrap",
};

export type CityLabelProps = {
	map: maplibregl.Map | null;
	position: LngLat;
	label: string;
	/** Sub-label, e.g. country or airport code. */
	sublabel?: string;
	/** Frame at which the label springs in. */
	enterFrame: number;
	/** Optional: hide after this frame. */
	exitFrame?: number;
	/** Pixel offset from the projected point. */
	offset?: [number, number];
};

export const CityLabel: React.FC<CityLabelProps> = ({
	map,
	position,
	label,
	sublabel,
	enterFrame,
	exitFrame,
	offset = [0, -28],
}) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const [screen, setScreen] = useState<{ x: number; y: number } | null>(null);

	// Project lat-lng to screen pixels every frame. Map.project is sync.
	useEffect(() => {
		if (!map) return;
		const p = map.project(position as [number, number]);
		setScreen({ x: p.x, y: p.y });
	}, [map, position, frame]);

	if (!screen) return null;

	const enterT = spring({
		frame: frame - enterFrame,
		fps,
		config: { damping: 18, mass: 0.8, stiffness: 110 },
		durationInFrames: 24,
	});

	const exiting = exitFrame !== undefined && frame > exitFrame;
	const exitT = exiting
		? spring({
				frame: frame - exitFrame!,
				fps,
				config: { damping: 22 },
				durationInFrames: 18,
			})
		: 0;

	const opacity = Math.max(0, enterT - exitT);
	const lift = (1 - enterT) * 14;

	return (
		<div
			style={{
				...LABEL_WRAPPER_BASE_STYLE,
				left: screen.x + offset[0],
				top: screen.y + offset[1],
				transform: `translate(-50%, -100%) translateY(${lift}px)`,
				opacity,
			}}
		>
			<div
				style={{
					fontSize: 44,
					fontWeight: 700,
					color: "#FEF3C7",
					letterSpacing: 1.5,
					textTransform: "uppercase",
					textShadow: "0 2px 12px rgba(0,0,0,0.55), 0 0 2px rgba(245,158,11,0.6)",
				}}
			>
				{label}
			</div>
			{sublabel ? (
				// Sublabel uses tighter tracking to satisfy react-doctor; original
				// design intent (wide tracking) is preserved via fontWeight + color
				// hierarchy against the primary label.
				<div
					style={{
						fontSize: 20,
						fontWeight: 500,
						color: "#FCD34D",
						marginTop: 4,
						letterSpacing: 0.5,
						textShadow: "0 1px 6px rgba(0,0,0,0.6)",
					}}
				>
					{sublabel}
				</div>
			) : null}
			<div
				style={{
					width: 8,
					height: 8,
					borderRadius: 8,
					background: "#F59E0B",
					margin: "12px auto 0",
					boxShadow: "0 0 16px 4px rgba(245,158,11,0.65)",
				}}
			/>
		</div>
	);
};
