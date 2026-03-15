import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";
import { Background } from "../components/Background";
import { Logo } from "../components/Logo";
import { GlowCard } from "../components/GlowCard";
import { colors, fonts } from "../lib/tokens";
import { useFadeIn, useScaleIn, useCounter, useGlow } from "../lib/animations";

/**
 * Reel 3: Cost Comparison — "$0 vs paid alternatives"
 * 9:16 format, ~15 seconds at 30fps (450 frames)
 *
 * Scenes:
 * 0-60:    "What are you paying for AI coding?" hook
 * 60-210:  Competitor price cards cross out
 * 210-350: 8gent $0 reveal with counter animation
 * 350-450: Features + CTA
 */
export const CostComparison: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background width={width} height={height} />

      {/* Scene 1: Hook */}
      <Sequence from={0} durationInFrames={90}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <div style={useFadeIn(0)}>
            <h1
              style={{
                fontFamily: fonts.sans,
                fontSize: 48,
                fontWeight: 800,
                color: colors.textBright,
                textAlign: "center",
                lineHeight: 1.4,
              }}
            >
              How much are you
              <br />
              <span style={{ color: colors.error }}>paying</span> for
              <br />
              AI coding tools?
            </h1>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 2: Competitor prices */}
      <Sequence from={60} durationInFrames={180}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {[
            { name: "Cursor Pro", price: "$20/mo", delay: 0, crossDelay: 60 },
            { name: "GitHub Copilot", price: "$19/mo", delay: 15, crossDelay: 75 },
            { name: "Claude Pro", price: "$20/mo", delay: 30, crossDelay: 90 },
            { name: "ChatGPT Plus", price: "$20/mo", delay: 45, crossDelay: 105 },
          ].map((item, i) => {
            const isCrossed = frame - 60 > item.crossDelay;
            return (
              <div key={i} style={useFadeIn(item.delay, 30)}>
                <div
                  style={{
                    width: 800,
                    padding: "24px 36px",
                    borderRadius: 16,
                    background: colors.bgCard,
                    border: `1px solid ${isCrossed ? colors.error + "44" : colors.border}`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    position: "relative",
                    opacity: isCrossed ? 0.4 : 1,
                    transition: "opacity 0.3s",
                  }}
                >
                  <span
                    style={{
                      fontFamily: fonts.sans,
                      fontSize: 28,
                      color: colors.text,
                    }}
                  >
                    {item.name}
                  </span>
                  <span
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 28,
                      fontWeight: 700,
                      color: colors.error,
                    }}
                  >
                    {item.price}
                  </span>
                  {/* Strikethrough line */}
                  {isCrossed && (
                    <div
                      style={{
                        position: "absolute",
                        left: 20,
                        right: 20,
                        top: "50%",
                        height: 3,
                        background: colors.error,
                        transform: "rotate(-2deg)",
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </AbsoluteFill>
      </Sequence>

      {/* Scene 3: $0 reveal */}
      <Sequence from={210} durationInFrames={170}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 30,
          }}
        >
          <Logo size={80} delay={0} />
          <div style={useScaleIn(15)}>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 140,
                fontWeight: 900,
                background: `linear-gradient(135deg, ${colors.brand}, ${colors.success})`,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                lineHeight: 1,
              }}
            >
              $0
            </div>
          </div>
          <div style={useFadeIn(30)}>
            <p
              style={{
                fontFamily: fonts.sans,
                fontSize: 32,
                color: colors.textMuted,
                textAlign: "center",
              }}
            >
              Free forever. Runs on your machine.
            </p>
          </div>

          <Sequence from={50}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                marginTop: 20,
              }}
            >
              {[
                { label: "API costs", value: "$0", delay: 0 },
                { label: "Monthly subscription", value: "$0", delay: 10 },
                { label: "Usage caps", value: "None", delay: 20 },
              ].map((row, i) => (
                <div
                  key={i}
                  style={{
                    ...useFadeIn(row.delay),
                    display: "flex",
                    justifyContent: "space-between",
                    width: 500,
                    fontFamily: fonts.sans,
                    fontSize: 24,
                  }}
                >
                  <span style={{ color: colors.textMuted }}>{row.label}</span>
                  <span style={{ color: colors.success, fontWeight: 700 }}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </Sequence>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 4: CTA */}
      <Sequence from={380} durationInFrames={70}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 24,
          }}
        >
          <div style={useFadeIn(0)}>
            <h2
              style={{
                fontFamily: fonts.sans,
                fontSize: 44,
                fontWeight: 800,
                color: colors.textBright,
                textAlign: "center",
                lineHeight: 1.3,
              }}
            >
              Stop paying for
              <br />
              <span style={{ color: colors.brand }}>what should be free.</span>
            </h2>
          </div>
          <div style={useFadeIn(15)}>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 26,
                color: colors.bg,
                background: `linear-gradient(135deg, ${colors.brand}, ${colors.success})`,
                padding: "16px 40px",
                borderRadius: 12,
                fontWeight: 700,
              }}
            >
              npm i -g 8gent-code
            </div>
          </div>
          <div style={useFadeIn(25)}>
            <p
              style={{
                fontFamily: fonts.mono,
                fontSize: 18,
                color: colors.textMuted,
              }}
            >
              github.com/AgenDa-Labs/8gent-code
            </p>
          </div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};
