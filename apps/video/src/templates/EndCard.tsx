/**
 * EndCard
 *
 * Spring-entry destination card for the closing 2-3 second beat.
 * Pure DOM/CSS — sits on top of the map. Earth palette only.
 */

import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const CARD_FONT_FAMILY = 'system-ui, -apple-system, "Inter", sans-serif';

const CARD_BASE_STYLE: React.CSSProperties = {
	position: "absolute",
	left: "50%",
	padding: "32px 40px",
	borderRadius: 20,
	background: "linear-gradient(180deg, rgba(11,30,63,0.86), rgba(11,30,63,0.94))",
	border: "1px solid rgba(245,158,11,0.35)",
	boxShadow: "0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(254,243,199,0.06) inset",
	fontFamily: CARD_FONT_FAMILY,
	color: "#FEF3C7",
	textAlign: "center",
};

export type EndCardProps = {
	enterFrame: number;
	title: string;
	subtitle?: string;
	meta?: string;
	/** Optional brand mark (rendered as text, no image required). */
	brandMark?: string;
};

export const EndCard: React.FC<EndCardProps> = ({
	enterFrame,
	title,
	subtitle,
	meta,
	brandMark,
}) => {
	const frame = useCurrentFrame();
	const { fps, width, height } = useVideoConfig();

	const enterT = spring({
		frame: frame - enterFrame,
		fps,
		config: { damping: 16, mass: 0.9, stiffness: 100 },
		durationInFrames: 30,
	});

	if (enterT <= 0) return null;

	const cardWidth = Math.min(width * 0.7, 900);
	const yLift = interpolate(enterT, [0, 1], [60, 0]);

	return (
		<div
			style={{
				...CARD_BASE_STYLE,
				bottom: height * 0.12,
				transform: `translate(-50%, 0) translateY(${yLift}px)`,
				opacity: enterT,
				width: cardWidth,
			}}
		>
			{brandMark ? (
				<div
					style={{
						fontSize: 14,
						letterSpacing: 6,
						color: "#FCD34D",
						textTransform: "uppercase",
						marginBottom: 12,
					}}
				>
					{brandMark}
				</div>
			) : null}
			<div
				style={{
					fontSize: 56,
					fontWeight: 700,
					letterSpacing: 0.5,
					lineHeight: 1.05,
				}}
			>
				{title}
			</div>
			{subtitle ? (
				<div
					style={{
						fontSize: 22,
						color: "#FCD34D",
						marginTop: 14,
						fontWeight: 500,
						letterSpacing: 0.5,
					}}
				>
					{subtitle}
				</div>
			) : null}
			{meta ? (
				<div
					style={{
						fontSize: 16,
						color: "rgba(254,243,199,0.7)",
						marginTop: 18,
						letterSpacing: 2,
						textTransform: "uppercase",
					}}
				>
					{meta}
				</div>
			) : null}
			<div
				style={{
					marginTop: 22,
					height: 2,
					width: 80,
					background: "#F59E0B",
					marginLeft: "auto",
					marginRight: "auto",
					boxShadow: "0 0 14px rgba(245,158,11,0.7)",
				}}
			/>
		</div>
	);
};
