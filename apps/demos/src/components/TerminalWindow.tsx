import type React from "react";
import { colors, fonts } from "../lib/tokens";
import { useFadeIn } from "../lib/animations";

interface TerminalWindowProps {
  title?: string;
  children: React.ReactNode;
  delay?: number;
  width?: number;
  height?: number;
}

export const TerminalWindow: React.FC<TerminalWindowProps> = ({
  title = "8gent",
  children,
  delay = 0,
  width = 900,
  height = 500,
}) => {
  const fadeStyle = useFadeIn(delay);

  return (
    <div
      style={{
        ...fadeStyle,
        width,
        height,
        borderRadius: 16,
        overflow: "hidden",
        border: `1px solid ${colors.border}`,
        boxShadow: `0 20px 60px rgba(0,0,0,0.5), 0 0 40px ${colors.brandGlow}`,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: 40,
          background: colors.bgCard,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 8,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: colors.error }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: colors.warning }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: colors.success }} />
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 13,
            color: colors.textMuted,
            marginLeft: 12,
          }}
        >
          {title}
        </span>
      </div>
      {/* Terminal body */}
      <div
        style={{
          background: colors.bg,
          padding: 24,
          height: height - 40,
          fontFamily: fonts.mono,
          fontSize: 18,
          lineHeight: 1.7,
          color: colors.text,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
};
