/**
 * 8gent Code - Advanced ASCII Animations
 *
 * High-impact visual effects for the TUI:
 * - Matrix rain (thinking background)
 * - Fire effect (error states)
 * - DNA helix (AI processing)
 * - Starfield warp (loading)
 * - Bouncing Braille dots (idle)
 * - Glitch text (intense processing)
 * - Confetti burst (completion)
 * - Audio waveform (voice mode)
 * - 3D Rubik's cube (loading spinner)
 * - Gradient wave text (header)
 */

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text } from "ink";

// ============================================
// Matrix Rain Effect
// ============================================

interface MatrixRainProps {
  width?: number;
  height?: number;
  speed?: number;
  density?: number;
}

const MATRIX_CHARS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789";

interface RainDrop {
  x: number;
  y: number;
  speed: number;
  chars: string[];
  length: number;
}

export function MatrixRain({
  width = 60,
  height = 15,
  speed = 80,
  density = 0.3,
}: MatrixRainProps) {
  const [drops, setDrops] = useState<RainDrop[]>([]);
  const [frame, setFrame] = useState(0);

  // Initialize drops
  useEffect(() => {
    const initialDrops: RainDrop[] = [];
    for (let x = 0; x < width; x++) {
      if (Math.random() < density) {
        initialDrops.push({
          x,
          y: Math.floor(Math.random() * height),
          speed: 1 + Math.random() * 2,
          chars: Array(8).fill(0).map(() =>
            MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]
          ),
          length: 4 + Math.floor(Math.random() * 6),
        });
      }
    }
    setDrops(initialDrops);
  }, [width, height, density]);

  // Animate
  useEffect(() => {
    const interval = setInterval(() => {
      setFrame(f => f + 1);
      setDrops(prev => prev.map(drop => ({
        ...drop,
        y: (drop.y + drop.speed) % (height + drop.length),
        chars: drop.chars.map((_, i) =>
          Math.random() < 0.1
            ? MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]
            : drop.chars[i]
        ),
      })));
    }, speed);
    return () => clearInterval(interval);
  }, [speed, height]);

  // Render grid
  const grid = useMemo(() => {
    const g: { char: string; brightness: number }[][] = Array(height)
      .fill(null)
      .map(() => Array(width).fill(null).map(() => ({ char: " ", brightness: 0 })));

    drops.forEach(drop => {
      for (let i = 0; i < drop.length; i++) {
        const y = Math.floor(drop.y) - i;
        if (y >= 0 && y < height) {
          const brightness = i === 0 ? 3 : i < 3 ? 2 : 1;
          g[y][drop.x] = {
            char: drop.chars[i % drop.chars.length],
            brightness
          };
        }
      }
    });

    return g;
  }, [drops, width, height]);

  return (
    <Box flexDirection="column">
      {grid.map((row, y) => (
        <Box key={y}>
          {row.map((cell, x) => (
            <Text
              key={x}
              color={cell.brightness === 3 ? "white" : cell.brightness === 2 ? "greenBright" : "green"}
              dimColor={cell.brightness === 1}
            >
              {cell.char}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Fire Effect
// ============================================

interface FireEffectProps {
  width?: number;
  height?: number;
  intensity?: number;
}

const FIRE_CHARS = " .:-=+*#%@";
const FIRE_COLORS = ["black", "red", "redBright", "yellow", "yellowBright", "white"] as const;

export function FireEffect({
  width = 40,
  height = 8,
  intensity = 0.7,
}: FireEffectProps) {
  const [buffer, setBuffer] = useState<number[][]>(() =>
    Array(height).fill(null).map(() => Array(width).fill(0))
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setBuffer(prev => {
        const next = prev.map(row => [...row]);

        // Set bottom row to random fire
        for (let x = 0; x < width; x++) {
          next[height - 1][x] = Math.random() < intensity ? 255 : 0;
        }

        // Propagate fire upward with cooling
        for (let y = 0; y < height - 1; y++) {
          for (let x = 0; x < width; x++) {
            const left = next[y + 1][(x - 1 + width) % width];
            const center = next[y + 1][x];
            const right = next[y + 1][(x + 1) % width];
            const below = y + 2 < height ? next[y + 2][x] : center;

            const avg = (left + center + right + below) / 4;
            const cooling = Math.random() * 30;
            next[y][x] = Math.max(0, avg - cooling);
          }
        }

        return next;
      });
    }, 50);
    return () => clearInterval(interval);
  }, [width, height, intensity]);

  return (
    <Box flexDirection="column">
      {buffer.map((row, y) => (
        <Box key={y}>
          {row.map((val, x) => {
            const charIndex = Math.floor((val / 255) * (FIRE_CHARS.length - 1));
            const colorIndex = Math.floor((val / 255) * (FIRE_COLORS.length - 1));
            return (
              <Text key={x} color={FIRE_COLORS[colorIndex]}>
                {FIRE_CHARS[charIndex]}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// DNA Helix
// ============================================

interface DNAHelixProps {
  width?: number;
  height?: number;
  speed?: number;
}

export function DNAHelix({
  width = 30,
  height = 10,
  speed = 100,
}: DNAHelixProps) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPhase(p => (p + 0.2) % (Math.PI * 2));
    }, speed);
    return () => clearInterval(interval);
  }, [speed]);

  const lines = useMemo(() => {
    const result: React.ReactNode[] = [];
    const bases = ["A", "T", "G", "C"];
    const baseColors = ["red", "cyan", "green", "yellow"] as const;

    for (let y = 0; y < height; y++) {
      const offset = phase + (y * 0.5);
      const x1 = Math.floor((Math.sin(offset) + 1) * (width / 2 - 2)) + 1;
      const x2 = Math.floor((Math.sin(offset + Math.PI) + 1) * (width / 2 - 2)) + 1;

      const line: React.ReactNode[] = [];
      for (let x = 0; x < width; x++) {
        const baseIndex = (y + Math.floor(phase)) % 4;
        if (x === x1) {
          line.push(<Text key={x} color={baseColors[baseIndex]} bold>{bases[baseIndex]}</Text>);
        } else if (x === x2) {
          line.push(<Text key={x} color={baseColors[(baseIndex + 2) % 4]} bold>{bases[(baseIndex + 2) % 4]}</Text>);
        } else if (x > Math.min(x1, x2) && x < Math.max(x1, x2) && Math.abs(x1 - x2) > 2) {
          // Draw connecting line
          line.push(<Text key={x} color="gray" dimColor>─</Text>);
        } else {
          line.push(<Text key={x}> </Text>);
        }
      }
      result.push(<Box key={y}>{line}</Box>);
    }
    return result;
  }, [phase, width, height]);

  return <Box flexDirection="column">{lines}</Box>;
}

// ============================================
// Starfield Warp
// ============================================

interface StarfieldProps {
  width?: number;
  height?: number;
  speed?: number;
  warp?: boolean;
}

interface Star {
  x: number;
  y: number;
  z: number;
}

export function Starfield({
  width = 50,
  height = 12,
  speed = 50,
  warp = false,
}: StarfieldProps) {
  const [stars, setStars] = useState<Star[]>(() =>
    Array(40).fill(null).map(() => ({
      x: (Math.random() - 0.5) * width * 2,
      y: (Math.random() - 0.5) * height * 2,
      z: Math.random() * 20 + 1,
    }))
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setStars(prev => prev.map(star => {
        const newZ = star.z - (warp ? 2 : 0.5);
        if (newZ <= 0) {
          return {
            x: (Math.random() - 0.5) * width * 2,
            y: (Math.random() - 0.5) * height * 2,
            z: 20,
          };
        }
        return { ...star, z: newZ };
      }));
    }, speed);
    return () => clearInterval(interval);
  }, [speed, warp, width, height]);

  const grid = useMemo(() => {
    const g: { char: string; color: string }[][] = Array(height)
      .fill(null)
      .map(() => Array(width).fill(null).map(() => ({ char: " ", color: "white" })));

    const centerX = width / 2;
    const centerY = height / 2;

    stars.forEach(star => {
      const projX = Math.floor(centerX + (star.x / star.z) * 10);
      const projY = Math.floor(centerY + (star.y / star.z) * 5);

      if (projX >= 0 && projX < width && projY >= 0 && projY < height) {
        const brightness = star.z < 5 ? "●" : star.z < 10 ? "○" : star.z < 15 ? "·" : ".";
        const color = star.z < 5 ? "white" : star.z < 10 ? "gray" : "gray";
        g[projY][projX] = { char: brightness, color };

        // Warp streaks
        if (warp && star.z < 8) {
          const streakLen = Math.floor((8 - star.z) / 2);
          for (let i = 1; i <= streakLen; i++) {
            const sx = projX + Math.sign(star.x) * i;
            const sy = projY + Math.sign(star.y) * Math.floor(i / 2);
            if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
              g[sy][sx] = { char: "─", color: "cyan" };
            }
          }
        }
      }
    });

    return g;
  }, [stars, width, height, warp]);

  return (
    <Box flexDirection="column">
      {grid.map((row, y) => (
        <Box key={y}>
          {row.map((cell, x) => (
            <Text key={x} color={cell.color as any} dimColor={cell.color === "gray"}>
              {cell.char}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Bouncing Braille Dots
// ============================================

interface BouncingDotsProps {
  width?: number;
  height?: number;
  count?: number;
}

const BRAILLE_BASE = 0x2800;

interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
}

export function BouncingDots({
  width = 40,
  height = 8,
  count = 8,
}: BouncingDotsProps) {
  const colors = ["cyan", "magenta", "yellow", "green", "red", "blue"];

  const [dots, setDots] = useState<Dot[]>(() =>
    Array(count).fill(null).map((_, i) => ({
      x: Math.random() * width * 2,
      y: Math.random() * height * 4,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 3,
      color: colors[i % colors.length],
    }))
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setDots(prev => prev.map(dot => {
        let { x, y, vx, vy } = dot;
        x += vx;
        y += vy;

        // Bounce off walls
        if (x <= 0 || x >= width * 2 - 1) vx = -vx;
        if (y <= 0 || y >= height * 4 - 1) vy = -vy;

        // Add gravity
        vy += 0.1;

        // Dampen
        vx *= 0.99;
        vy *= 0.99;

        return {
          ...dot,
          x: Math.max(0, Math.min(width * 2 - 1, x)),
          y: Math.max(0, Math.min(height * 4 - 1, y)),
          vx,
          vy,
        };
      }));
    }, 50);
    return () => clearInterval(interval);
  }, [width, height]);

  // Render using Braille characters (2x4 dots per character)
  const grid = useMemo(() => {
    const cells: { dots: number; color: string }[][] = Array(height)
      .fill(null)
      .map(() => Array(width).fill(null).map(() => ({ dots: 0, color: "white" })));

    dots.forEach(dot => {
      const cellX = Math.floor(dot.x / 2);
      const cellY = Math.floor(dot.y / 4);
      const subX = Math.floor(dot.x) % 2;
      const subY = Math.floor(dot.y) % 4;

      if (cellX >= 0 && cellX < width && cellY >= 0 && cellY < height) {
        // Braille dot positions
        const dotBit = subX === 0
          ? [0x01, 0x02, 0x04, 0x40][subY]
          : [0x08, 0x10, 0x20, 0x80][subY];

        cells[cellY][cellX].dots |= dotBit;
        cells[cellY][cellX].color = dot.color;
      }
    });

    return cells;
  }, [dots, width, height]);

  return (
    <Box flexDirection="column">
      {grid.map((row, y) => (
        <Box key={y}>
          {row.map((cell, x) => (
            <Text key={x} color={cell.color as any}>
              {String.fromCharCode(BRAILLE_BASE + cell.dots)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Glitch Text Effect
// ============================================

interface GlitchTextProps {
  text: string;
  intensity?: number;
  speed?: number;
}

const GLITCH_CHARS = "!@#$%^&*()_+-=[]{}|;':\",./<>?\\`~";

export function GlitchText({
  text,
  intensity = 0.3,
  speed = 100,
}: GlitchTextProps) {
  const [glitched, setGlitched] = useState(text);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setGlitched(text.split("").map((char, i) => {
        if (Math.random() < intensity) {
          return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
        }
        return char;
      }).join(""));

      setOffset(Math.random() < 0.2 ? Math.floor(Math.random() * 3) - 1 : 0);
    }, speed);
    return () => clearInterval(interval);
  }, [text, intensity, speed]);

  return (
    <Box>
      {offset > 0 && <Text> </Text>}
      <Text color="red">{glitched.slice(0, 2)}</Text>
      <Text color="white">{glitched.slice(2, -2)}</Text>
      <Text color="cyan">{glitched.slice(-2)}</Text>
    </Box>
  );
}

// ============================================
// Confetti Burst
// ============================================

interface ConfettiProps {
  width?: number;
  height?: number;
  duration?: number;
  onComplete?: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  char: string;
  color: string;
}

const CONFETTI_CHARS = ["★", "✦", "✧", "◆", "◇", "●", "○", "■", "□", "▲", "△"];
const CONFETTI_COLORS = ["red", "yellow", "green", "cyan", "blue", "magenta", "white"];

export function Confetti({
  width = 50,
  height = 15,
  duration = 3000,
  onComplete,
}: ConfettiProps) {
  const [particles, setParticles] = useState<Particle[]>(() =>
    Array(30).fill(null).map(() => ({
      x: width / 2,
      y: height / 2,
      vx: (Math.random() - 0.5) * 4,
      vy: -Math.random() * 3 - 1,
      char: CONFETTI_CHARS[Math.floor(Math.random() * CONFETTI_CHARS.length)],
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    }))
  );
  const [active, setActive] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setActive(false);
      onComplete?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onComplete]);

  useEffect(() => {
    if (!active) return;

    const interval = setInterval(() => {
      setParticles(prev => prev.map(p => ({
        ...p,
        x: p.x + p.vx,
        y: p.y + p.vy,
        vy: p.vy + 0.15, // gravity
        vx: p.vx * 0.98, // air resistance
      })));
    }, 50);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return null;

  const grid: { char: string; color: string }[][] = Array(height)
    .fill(null)
    .map(() => Array(width).fill(null).map(() => ({ char: " ", color: "white" })));

  particles.forEach(p => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x >= 0 && x < width && y >= 0 && y < height) {
      grid[y][x] = { char: p.char, color: p.color };
    }
  });

  return (
    <Box flexDirection="column">
      {grid.map((row, y) => (
        <Box key={y}>
          {row.map((cell, x) => (
            <Text key={x} color={cell.color as any}>
              {cell.char}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Audio Waveform
// ============================================

interface WaveformProps {
  width?: number;
  height?: number;
  speed?: number;
  active?: boolean;
}

const WAVEFORM_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function Waveform({
  width = 30,
  height = 4,
  speed = 100,
  active = true,
}: WaveformProps) {
  const [phase, setPhase] = useState(0);
  const [levels, setLevels] = useState<number[]>(() =>
    Array(width).fill(0).map(() => Math.random())
  );

  useEffect(() => {
    if (!active) return;

    const interval = setInterval(() => {
      setPhase(p => p + 0.3);
      setLevels(prev => prev.map((_, i) => {
        const wave1 = Math.sin(phase + i * 0.3) * 0.3;
        const wave2 = Math.sin(phase * 1.5 + i * 0.2) * 0.2;
        const noise = (Math.random() - 0.5) * 0.3;
        return Math.max(0, Math.min(1, 0.5 + wave1 + wave2 + noise));
      }));
    }, speed);
    return () => clearInterval(interval);
  }, [active, speed, phase]);

  if (!active) {
    return (
      <Box>
        {Array(width).fill(0).map((_, i) => (
          <Text key={i} color="gray" dimColor>▁</Text>
        ))}
      </Box>
    );
  }

  return (
    <Box>
      {levels.map((level, i) => {
        const charIndex = Math.floor(level * (WAVEFORM_CHARS.length - 1));
        const hue = (i / width) * 360;
        const color = level > 0.7 ? "greenBright" : level > 0.4 ? "green" : "gray";
        return (
          <Text key={i} color={color}>
            {WAVEFORM_CHARS[charIndex]}
          </Text>
        );
      })}
    </Box>
  );
}

// ============================================
// 3D Rubik's Cube
// ============================================

interface RubiksCubeProps {
  size?: number;
  speed?: number;
}

// ASCII art frames for rotating cube with colored faces
const CUBE_FRAMES = [
  // Front face visible
  [
    "    ╭───────╮    ",
    "   ╱ R R R ╱│    ",
    "  ╱ R R R ╱ │    ",
    " ╱ R R R ╱  │    ",
    "├───────┤ B │    ",
    "│ W W W │ B │    ",
    "│ W W W │ B │    ",
    "│ W W W │╱      ",
    "╰───────╯        ",
  ],
  // Rotating right
  [
    "     ╭──────╮    ",
    "    ╱ R R ╱│     ",
    "   ╱ R R ╱ │     ",
    "  ╱ R R ╱  │     ",
    " ├──────┤ B B    ",
    " │ W W │ B B │   ",
    " │ W W │ B B │   ",
    " │ W W │╱        ",
    " ╰──────╯        ",
  ],
  // Side view
  [
    "      ╭─────╮    ",
    "     ╱ R ╱│      ",
    "    ╱ R ╱ │      ",
    "   ├─────┤ B B B ",
    "   │ W │ B B B │ ",
    "   │ W │ B B B │ ",
    "   │ W │╱        ",
    "   ╰─────╯       ",
  ],
  // More rotation
  [
    "       ╭────╮    ",
    "      ╱╱│        ",
    "     ├────┤ B B B",
    "     │ │ B B B │ ",
    "     │ │ B B B │ ",
    "     ╰────╯╱     ",
  ],
];

const FACE_COLORS: Record<string, string> = {
  "R": "red",      // Red face
  "W": "white",    // White face
  "B": "blue",     // Blue face
  "G": "green",    // Green face
  "Y": "yellow",   // Yellow face
  "O": "magenta",  // Orange (using magenta)
};

export function RubiksCube({ size = 1, speed = 200 }: RubiksCubeProps) {
  const [rotation, setRotation] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);

  // Cube faces cycling through colors
  const faceColors = useMemo(() => {
    const faces = ["R", "W", "B", "G", "Y", "O"];
    const offset = Math.floor(rotation / 60) % 6;
    return {
      front: faces[(0 + offset) % 6],
      right: faces[(1 + offset) % 6],
      top: faces[(2 + offset) % 6],
    };
  }, [rotation]);

  useEffect(() => {
    const interval = setInterval(() => {
      setRotation(r => (r + 15) % 360);
      setFrameIndex(f => (f + 1) % 8);
    }, speed);
    return () => clearInterval(interval);
  }, [speed]);

  // Generate a simple rotating cube
  const cubeLines = useMemo(() => {
    const angle = rotation * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Simplified 3D cube projection
    const cubeSize = 4;
    const lines: string[] = [];

    // Top face
    const topOffset = Math.abs(Math.sin(angle)) * 2;
    lines.push(`    ${"╭" + "─".repeat(cubeSize * 2) + "╮"}`);
    lines.push(`   ${"╱".padStart(2)} ${faceColors.top.repeat(cubeSize)} ${"╱"}│`);
    lines.push(`  ${"╱".padStart(2)} ${faceColors.top.repeat(cubeSize)} ${"╱"} │`);

    // Front and right faces
    lines.push(` ├${"─".repeat(cubeSize * 2)}┤ ${faceColors.right} │`);
    for (let i = 0; i < 3; i++) {
      lines.push(` │ ${faceColors.front.repeat(cubeSize)} │ ${faceColors.right} │`);
    }
    lines.push(` ╰${"─".repeat(cubeSize * 2)}╯╱`);

    return lines;
  }, [rotation, faceColors]);

  return (
    <Box flexDirection="column">
      {cubeLines.map((line, i) => (
        <Box key={i}>
          {line.split("").map((char, j) => {
            if (FACE_COLORS[char]) {
              return <Text key={j} color={FACE_COLORS[char] as any}>█</Text>;
            }
            return <Text key={j} color="gray">{char}</Text>;
          })}
        </Box>
      ))}
    </Box>
  );
}

// ============================================
// Gradient Wave Header
// ============================================

interface GradientWaveProps {
  text: string;
  speed?: number;
}

const GRADIENT_COLORS = [
  "red", "redBright", "yellow", "yellowBright",
  "green", "greenBright", "cyan", "cyanBright",
  "blue", "blueBright", "magenta", "magentaBright",
] as const;

export function GradientWave({ text, speed = 150 }: GradientWaveProps) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setOffset(o => (o + 1) % GRADIENT_COLORS.length);
    }, speed);
    return () => clearInterval(interval);
  }, [speed]);

  return (
    <Box>
      {text.split("").map((char, i) => {
        const colorIndex = (i + offset) % GRADIENT_COLORS.length;
        return (
          <Text key={i} color={GRADIENT_COLORS[colorIndex]} bold>
            {char}
          </Text>
        );
      })}
    </Box>
  );
}

// ============================================
// Combined Loading Animation
// ============================================

interface LoadingAnimationProps {
  type: "matrix" | "fire" | "dna" | "starfield" | "dots" | "cube" | "waveform";
  width?: number;
  height?: number;
}

export function LoadingAnimation({ type, width, height }: LoadingAnimationProps) {
  switch (type) {
    case "matrix":
      return <MatrixRain width={width} height={height} />;
    case "fire":
      return <FireEffect width={width} height={height} />;
    case "dna":
      return <DNAHelix width={width} height={height} />;
    case "starfield":
      return <Starfield width={width} height={height} warp />;
    case "dots":
      return <BouncingDots width={width} height={height} />;
    case "cube":
      return <RubiksCube />;
    case "waveform":
      return <Waveform width={width} />;
    default:
      return <MatrixRain width={width} height={height} />;
  }
}

// ============================================
// Exports
// ============================================

export default {
  MatrixRain,
  FireEffect,
  DNAHelix,
  Starfield,
  BouncingDots,
  GlitchText,
  Confetti,
  Waveform,
  RubiksCube,
  GradientWave,
  LoadingAnimation,
};
