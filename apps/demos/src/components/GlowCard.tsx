import type React from "react";
import { colors, fonts } from "../lib/tokens";
import { useFadeIn, useGlow } from "../lib/animations";

interface GlowCardProps {
  children: React.ReactNode;
  delay?: number;
  width?: number;
  accentColor?: string;
}

export const GlowCard: React.FC<GlowCardProps> = ({
  children,
  delay = 0,
  width = 900,
  accentColor = colors.brand,
}) => {
  const fadeStyle = useFadeIn(delay, 40);
  const glow = useGlow(0.06);

  return (
    <div
      style={{
        ...fadeStyle,
        width,
        padding: 40,
        borderRadius: 20,
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        boxShadow: `0 0 ${30 + 20 * glow}px ${accentColor}33`,
        fontFamily: fonts.sans,
      }}
    >
      {children}
    </div>
  );
};
