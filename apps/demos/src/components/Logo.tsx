import type React from "react";
import { useCurrentFrame } from "remotion";
import { colors, fonts } from "../lib/tokens";
import { useGlow, useScaleIn } from "../lib/animations";

export const Logo: React.FC<{ size?: number; delay?: number }> = ({
  size = 120,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const scaleStyle = useScaleIn(delay);
  const glow = useGlow(0.08);

  return (
    <div style={{ ...scaleStyle, display: "flex", alignItems: "center", gap: 20 }}>
      {/* Animated 8 logo */}
      <svg width={size} height={size} viewBox="0 0 100 100">
        <defs>
          <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={colors.brand} />
            <stop offset="100%" stopColor={colors.accent} />
          </linearGradient>
          <filter id="logoGlow">
            <feGaussianBlur stdDeviation={4 * glow} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* The "8" shape — two circles */}
        <circle
          cx="50"
          cy="33"
          r="22"
          fill="none"
          stroke="url(#logoGrad)"
          strokeWidth="4"
          filter="url(#logoGlow)"
        />
        <circle
          cx="50"
          cy="67"
          r="26"
          fill="none"
          stroke="url(#logoGrad)"
          strokeWidth="4"
          filter="url(#logoGlow)"
        />
        {/* Animated orbit dot */}
        <circle
          cx={50 + 24 * Math.cos(frame * 0.1)}
          cy={50 + 24 * Math.sin(frame * 0.1)}
          r="4"
          fill={colors.brand}
          opacity={0.8}
        />
      </svg>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: size * 0.45,
            fontWeight: 800,
            color: colors.textBright,
            letterSpacing: -2,
          }}
        >
          8gent
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: size * 0.18,
            color: colors.brand,
            letterSpacing: 4,
            textTransform: "uppercase",
          }}
        >
          code
        </span>
      </div>
    </div>
  );
};
