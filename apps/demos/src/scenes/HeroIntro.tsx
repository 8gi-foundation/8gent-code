import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { Background } from "../components/Background";
import { Logo } from "../components/Logo";
import { TerminalWindow } from "../components/TerminalWindow";
import { CodeBlock } from "../components/CodeBlock";
import { colors, fonts, sizes } from "../lib/tokens";
import { useFadeIn, useTypewriter, useGlow } from "../lib/animations";

/**
 * Reel 1: Hero Intro — "What is 8gent-code?"
 * 9:16 format, ~15 seconds at 30fps (450 frames)
 *
 * Scene breakdown:
 * 0-60:    Logo animation + tagline
 * 60-180:  Terminal showing agent in action
 * 180-300: Feature bullets slide in
 * 300-400: "Never hit usage caps again" punch line
 * 400-450: CTA
 */
export const HeroIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background width={width} height={height} />

      {/* Scene 1: Logo + Tagline */}
      <Sequence from={0} durationInFrames={180}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 40,
          }}
        >
          <Logo size={140} delay={10} />
          <div style={useFadeIn(30)}>
            <p
              style={{
                fontFamily: fonts.sans,
                fontSize: 36,
                color: colors.textMuted,
                textAlign: "center",
                maxWidth: 800,
                lineHeight: 1.5,
              }}
            >
              Autonomous coding agent
              <br />
              powered by{" "}
              <span style={{ color: colors.brand }}>local LLMs</span>
            </p>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 2: Terminal demo */}
      <Sequence from={90} durationInFrames={210}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 30,
          }}
        >
          <TerminalWindow title="~/my-project" delay={0} width={950} height={600}>
            <div>
              <span style={{ color: colors.success }}>$</span>{" "}
              <span style={{ color: colors.brand }}>
                {useTypewriter("8gent 'add dark mode to settings'", 15, 2)}
              </span>
            </div>
            <Sequence from={60}>
              <div style={{ marginTop: 16 }}>
                <span style={{ color: colors.textMuted }}>
                  {useTypewriter("analyzing codebase...", 0, 2)}
                </span>
              </div>
            </Sequence>
            <Sequence from={90}>
              <div style={{ marginTop: 8 }}>
                <span style={{ color: colors.success }}>
                  {useTypewriter("found 12 components to update", 0, 2)}
                </span>
              </div>
            </Sequence>
            <Sequence from={110}>
              <div style={{ marginTop: 8 }}>
                <span style={{ color: colors.accent }}>
                  {useTypewriter("writing theme provider...", 0, 2)}
                </span>
              </div>
            </Sequence>
            <Sequence from={130}>
              <div style={{ marginTop: 8 }}>
                <span style={{ color: colors.accent }}>
                  {useTypewriter("updating SettingsScreen.tsx...", 0, 2)}
                </span>
              </div>
            </Sequence>
            <Sequence from={155}>
              <div style={{ marginTop: 16 }}>
                <span style={{ color: colors.success, fontWeight: 700 }}>
                  {useTypewriter("done. 12 files changed, all tests pass.", 0, 2)}
                </span>
              </div>
            </Sequence>
          </TerminalWindow>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 3: Feature bullets */}
      <Sequence from={300} durationInFrames={100}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 28,
              padding: 60,
            }}
          >
            {[
              { icon: "🧠", text: "Runs on Ollama — fully local", delay: 0 },
              { icon: "🔓", text: "No API keys required", delay: 12 },
              { icon: "♾️", text: "Zero usage caps", delay: 24 },
              { icon: "🛠️", text: "File editing, git, terminal", delay: 36 },
            ].map((item, i) => (
              <div
                key={i}
                style={{
                  ...useFadeIn(item.delay, 30),
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                  fontFamily: fonts.sans,
                  fontSize: 34,
                  color: colors.text,
                }}
              >
                <span style={{ fontSize: 42 }}>{item.icon}</span>
                {item.text}
              </div>
            ))}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 4: Punchline + CTA */}
      <Sequence from={400} durationInFrames={50}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 30,
          }}
        >
          <div style={useFadeIn(0)}>
            <h1
              style={{
                fontFamily: fonts.sans,
                fontSize: 52,
                fontWeight: 800,
                color: colors.textBright,
                textAlign: "center",
                lineHeight: 1.3,
              }}
            >
              Never hit usage caps
              <br />
              <span style={{ color: colors.brand }}>again.</span>
            </h1>
          </div>
          <div style={useFadeIn(15)}>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 28,
                color: colors.bg,
                background: `linear-gradient(135deg, ${colors.brand}, ${colors.accent})`,
                padding: "16px 40px",
                borderRadius: 12,
                fontWeight: 700,
              }}
            >
              npm i -g 8gent-code
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};
