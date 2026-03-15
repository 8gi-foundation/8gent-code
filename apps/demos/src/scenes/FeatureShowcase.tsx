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
import { TerminalWindow } from "../components/TerminalWindow";
import { GlowCard } from "../components/GlowCard";
import { CodeBlock } from "../components/CodeBlock";
import { colors, fonts, sizes } from "../lib/tokens";
import { useFadeIn, useTypewriter, useScaleIn, useGlow } from "../lib/animations";

/**
 * Reel 2: Feature Showcase — autonomous coding in action
 * 9:16 format, ~20 seconds at 30fps (600 frames)
 *
 * Scenes:
 * 0-90:    "What if your AI agent..." hook
 * 90-270:  Live coding demo — agent writes a React component
 * 270-420: Multi-tool showcase (file edit, git, terminal)
 * 420-540: TUI interface preview
 * 540-600: CTA
 */
export const FeatureShowcase: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background width={width} height={height} />

      {/* Scene 1: Hook */}
      <Sequence from={0} durationInFrames={120}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 20,
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
                maxWidth: 900,
              }}
            >
              What if your AI agent
              <br />
              could <span style={{ color: colors.brand }}>actually code</span>?
            </h1>
          </div>
          <div style={useFadeIn(20)}>
            <p
              style={{
                fontFamily: fonts.sans,
                fontSize: 28,
                color: colors.textMuted,
                textAlign: "center",
              }}
            >
              Not just suggest. Actually write, test, and ship.
            </p>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 2: Live coding demo */}
      <Sequence from={90} durationInFrames={210}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 20,
          }}
        >
          <div style={useFadeIn(0)}>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 20,
                color: colors.brand,
                letterSpacing: 3,
                textTransform: "uppercase",
              }}
            >
              watch it work
            </span>
          </div>

          <TerminalWindow title="8gent — coding" delay={10} width={950} height={700}>
            <CodeBlock
              delay={20}
              speed={2}
              code={`// 8gent is writing a component...

import React from 'react';

export const DarkModeToggle = () => {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    document.body.classList
      .toggle('dark', dark);
  }, [dark]);

  return (
    <button onClick={() => setDark(!dark)}>
      {dark ? '☀️' : '🌙'}
    </button>
  );
};`}
            />
          </TerminalWindow>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 3: Multi-tool showcase */}
      <Sequence from={270} durationInFrames={180}>
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
                fontSize: 38,
                fontWeight: 700,
                color: colors.textBright,
                textAlign: "center",
                marginBottom: 20,
              }}
            >
              Full toolkit. Zero limits.
            </h2>
          </div>

          {[
            {
              icon: "📝",
              title: "File Operations",
              desc: "Read, write, edit any file in your project",
              color: colors.brand,
              delay: 15,
            },
            {
              icon: "🔀",
              title: "Git Integration",
              desc: "Commit, branch, diff — all autonomous",
              color: colors.success,
              delay: 30,
            },
            {
              icon: "💻",
              title: "Terminal Access",
              desc: "Run tests, install deps, execute scripts",
              color: colors.accent,
              delay: 45,
            },
            {
              icon: "🌐",
              title: "Web Research",
              desc: "Fetch docs, search APIs, scrape pages",
              color: colors.warning,
              delay: 60,
            },
          ].map((item, i) => (
            <GlowCard key={i} delay={item.delay} width={900} accentColor={item.color}>
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                <span style={{ fontSize: 40 }}>{item.icon}</span>
                <div>
                  <div
                    style={{
                      fontFamily: fonts.sans,
                      fontSize: 26,
                      fontWeight: 700,
                      color: item.color,
                    }}
                  >
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontFamily: fonts.sans,
                      fontSize: 20,
                      color: colors.textMuted,
                      marginTop: 4,
                    }}
                  >
                    {item.desc}
                  </div>
                </div>
              </div>
            </GlowCard>
          ))}
        </AbsoluteFill>
      </Sequence>

      {/* Scene 4: TUI Preview */}
      <Sequence from={420} durationInFrames={120}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 30,
          }}
        >
          <div style={useFadeIn(0)}>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 20,
                color: colors.brand,
                letterSpacing: 3,
                textTransform: "uppercase",
              }}
            >
              beautiful TUI
            </span>
          </div>
          <TerminalWindow title="8gent" delay={10} width={950} height={650}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: colors.brand, fontWeight: 700, fontSize: 22 }}>
                  8gent v0.5.0
                </span>
                <span style={{ color: colors.textMuted }}>
                  ollama/qwen3.5
                </span>
              </div>
              <div
                style={{
                  height: 1,
                  background: colors.border,
                  margin: "8px 0",
                }}
              />
              <div>
                <span style={{ color: colors.success }}>user</span>
                <span style={{ color: colors.textMuted }}> &gt; </span>
                <span style={{ color: colors.text }}>
                  {useTypewriter("add authentication to the API routes", 20, 2)}
                </span>
              </div>
              <Sequence from={60}>
                <div style={{ marginTop: 8 }}>
                  <span style={{ color: colors.accent }}>8gent</span>
                  <span style={{ color: colors.textMuted }}> &gt; </span>
                  <span style={{ color: colors.text }}>
                    {useTypewriter(
                      "I'll add JWT auth middleware and protect all routes. Let me start by...",
                      0,
                      1.5
                    )}
                  </span>
                </div>
              </Sequence>
            </div>
          </TerminalWindow>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 5: CTA */}
      <Sequence from={540} durationInFrames={60}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
            gap: 24,
          }}
        >
          <Logo size={100} delay={0} />
          <div style={useFadeIn(10)}>
            <h2
              style={{
                fontFamily: fonts.sans,
                fontSize: 40,
                fontWeight: 800,
                color: colors.textBright,
                textAlign: "center",
              }}
            >
              Your AI pair programmer.
              <br />
              <span style={{ color: colors.brand }}>Runs locally.</span>
            </h2>
          </div>
          <div style={useFadeIn(20)}>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 24,
                color: colors.bg,
                background: `linear-gradient(135deg, ${colors.brand}, ${colors.accent})`,
                padding: "14px 36px",
                borderRadius: 12,
                fontWeight: 700,
              }}
            >
              github.com/AgenDa-Labs/8gent-code
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};
