import type React from "react";
import { useCurrentFrame } from "remotion";
import { colors } from "../lib/tokens";

/** Animated dark gradient background with floating particles */
export const Background: React.FC<{
  width: number;
  height: number;
}> = ({ width, height }) => {
  const frame = useCurrentFrame();

  // Generate deterministic particles
  const particles = Array.from({ length: 30 }, (_, i) => {
    const seed = i * 137.508; // golden angle
    const x = ((seed * 7.3) % width);
    const y = ((seed * 13.7 + frame * (0.3 + (i % 5) * 0.1)) % (height + 40)) - 20;
    const size = 2 + (i % 4);
    const opacity = 0.1 + (i % 3) * 0.08;
    return { x, y, size, opacity };
  });

  return (
    <div
      style={{
        position: "absolute",
        width,
        height,
        background: `radial-gradient(ellipse at 50% 30%, ${colors.bgCard} 0%, ${colors.bg} 70%)`,
        overflow: "hidden",
      }}
    >
      {/* Grid overlay */}
      <svg width={width} height={height} style={{ position: "absolute", opacity: 0.04 }}>
        {Array.from({ length: Math.ceil(width / 60) }, (_, i) => (
          <line
            key={`v${i}`}
            x1={i * 60}
            y1={0}
            x2={i * 60}
            y2={height}
            stroke={colors.brand}
            strokeWidth={1}
          />
        ))}
        {Array.from({ length: Math.ceil(height / 60) }, (_, i) => (
          <line
            key={`h${i}`}
            x1={0}
            y1={i * 60}
            x2={width}
            y2={i * 60}
            stroke={colors.brand}
            strokeWidth={1}
          />
        ))}
      </svg>

      {/* Floating particles */}
      {particles.map((p, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: p.x,
            top: p.y,
            width: p.size,
            height: p.size,
            borderRadius: "50%",
            background: i % 3 === 0 ? colors.brand : colors.accent,
            opacity: p.opacity,
          }}
        />
      ))}
    </div>
  );
};
