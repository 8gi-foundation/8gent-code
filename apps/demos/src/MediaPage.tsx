import React, { useState } from "react";
import { Player } from "@remotion/player";
import { HeroIntro } from "./scenes/HeroIntro";
import { FeatureShowcase } from "./scenes/FeatureShowcase";
import { CostComparison } from "./scenes/CostComparison";
import { sizes } from "./lib/tokens";

const compositions = [
  {
    id: "HeroIntro",
    title: "Reel 1: Hero Intro",
    description: "Logo animation → terminal demo → feature bullets → CTA",
    component: HeroIntro,
    durationInFrames: 450,
    duration: "15s",
  },
  {
    id: "FeatureShowcase",
    title: "Reel 2: Feature Showcase",
    description: "Hook → live coding → multi-tool cards → TUI preview → CTA",
    component: FeatureShowcase,
    durationInFrames: 600,
    duration: "20s",
  },
  {
    id: "CostComparison",
    title: "Reel 3: Cost Comparison",
    description: "Competitor prices → strikethrough → $0 reveal → CTA",
    component: CostComparison,
    durationInFrames: 450,
    duration: "15s",
  },
] as const;

type AspectRatio = "vertical" | "landscape";

export const MediaPage: React.FC = () => {
  const [aspect, setAspect] = useState<AspectRatio>("vertical");
  const [selectedId, setSelectedId] = useState<string>("HeroIntro");

  const selected = compositions.find((c) => c.id === selectedId) ?? compositions[0];

  const isVertical = aspect === "vertical";
  const width = isVertical ? sizes.reelWidth : sizes.landscapeWidth;
  const height = isVertical ? sizes.reelHeight : sizes.landscapeHeight;

  // Scale player to fit viewport
  const maxPlayerHeight = 700;
  const scale = Math.min(1, maxPlayerHeight / height);
  const playerWidth = Math.round(width * scale);
  const playerHeight = Math.round(height * scale);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>8gent Media Suite</h1>
        <p style={styles.subtitle}>
          Preview and iterate on video compositions before rendering
        </p>
      </header>

      <div style={styles.layout}>
        {/* Sidebar */}
        <aside style={styles.sidebar}>
          <h3 style={styles.sectionTitle}>Compositions</h3>
          {compositions.map((comp) => (
            <button
              key={comp.id}
              onClick={() => setSelectedId(comp.id)}
              style={{
                ...styles.compButton,
                ...(selectedId === comp.id ? styles.compButtonActive : {}),
              }}
            >
              <div style={styles.compTitle}>{comp.title}</div>
              <div style={styles.compDesc}>{comp.description}</div>
              <div style={styles.compMeta}>{comp.duration} · {comp.durationInFrames} frames</div>
            </button>
          ))}

          <h3 style={{ ...styles.sectionTitle, marginTop: 32 }}>Aspect Ratio</h3>
          <div style={styles.aspectToggle}>
            <button
              onClick={() => setAspect("vertical")}
              style={{
                ...styles.aspectButton,
                ...(isVertical ? styles.aspectButtonActive : {}),
              }}
            >
              9:16 Reel
            </button>
            <button
              onClick={() => setAspect("landscape")}
              style={{
                ...styles.aspectButton,
                ...(!isVertical ? styles.aspectButtonActive : {}),
              }}
            >
              16:9 Landscape
            </button>
          </div>

          <h3 style={{ ...styles.sectionTitle, marginTop: 32 }}>Render Commands</h3>
          <code style={styles.codeBlock}>
            {`# Render this composition\nnpx remotion render src/index.ts \\\n  ${selected.id}${!isVertical ? "-Landscape" : ""} \\\n  out/${selected.id.toLowerCase()}.mp4`}
          </code>
        </aside>

        {/* Player area */}
        <main style={styles.main}>
          <div style={styles.playerContainer}>
            <Player
              component={selected.component}
              compositionWidth={width}
              compositionHeight={height}
              durationInFrames={selected.durationInFrames}
              fps={30}
              style={{
                width: playerWidth,
                height: playerHeight,
                borderRadius: 12,
                overflow: "hidden",
                boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
              }}
              controls
              autoPlay
              loop
            />
          </div>
          <div style={styles.playerInfo}>
            <span style={styles.badge}>
              {width}×{height}
            </span>
            <span style={styles.badge}>30fps</span>
            <span style={styles.badge}>{selected.durationInFrames} frames</span>
            <span style={styles.badge}>{selected.duration}</span>
          </div>
        </main>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#0a0a0f",
    color: "#e0e0e0",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  header: {
    padding: "32px 40px 16px",
    borderBottom: "1px solid #2a2a3e",
  },
  title: {
    fontSize: 28,
    fontWeight: 800,
    color: "#fff",
    margin: 0,
  },
  subtitle: {
    fontSize: 14,
    color: "#808090",
    margin: "4px 0 0",
  },
  layout: {
    display: "flex",
    minHeight: "calc(100vh - 100px)",
  },
  sidebar: {
    width: 320,
    padding: 24,
    borderRight: "1px solid #2a2a3e",
    flexShrink: 0,
    overflowY: "auto" as const,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#808090",
    textTransform: "uppercase" as const,
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  compButton: {
    display: "block",
    width: "100%",
    textAlign: "left" as const,
    padding: "12px 16px",
    marginBottom: 8,
    borderRadius: 10,
    border: "1px solid #2a2a3e",
    background: "#12121a",
    cursor: "pointer",
    color: "#e0e0e0",
    transition: "all 0.15s",
  },
  compButtonActive: {
    borderColor: "#00e5ff",
    background: "#1a1a2e",
    boxShadow: "0 0 20px rgba(0, 229, 255, 0.1)",
  },
  compTitle: {
    fontSize: 15,
    fontWeight: 700,
    marginBottom: 4,
  },
  compDesc: {
    fontSize: 12,
    color: "#808090",
    lineHeight: 1.4,
  },
  compMeta: {
    fontSize: 11,
    color: "#00e5ff",
    marginTop: 6,
    fontFamily: "JetBrains Mono, monospace",
  },
  aspectToggle: {
    display: "flex",
    gap: 8,
  },
  aspectButton: {
    flex: 1,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #2a2a3e",
    background: "#12121a",
    color: "#808090",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  aspectButtonActive: {
    borderColor: "#00e5ff",
    color: "#00e5ff",
    background: "#1a1a2e",
  },
  codeBlock: {
    display: "block",
    padding: 12,
    borderRadius: 8,
    background: "#12121a",
    border: "1px solid #2a2a3e",
    fontSize: 11,
    fontFamily: "JetBrains Mono, monospace",
    color: "#00e5ff",
    whiteSpace: "pre" as const,
    lineHeight: 1.6,
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
  },
  playerContainer: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  playerInfo: {
    display: "flex",
    gap: 12,
    marginTop: 20,
  },
  badge: {
    padding: "4px 12px",
    borderRadius: 6,
    background: "#1a1a2e",
    border: "1px solid #2a2a3e",
    fontSize: 12,
    fontFamily: "JetBrains Mono, monospace",
    color: "#808090",
  },
};
