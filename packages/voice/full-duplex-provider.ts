/**
 * @8gent/voice — FullDuplexProvider
 *
 * Interface and machine-aware backend selection for full-duplex voice.
 * Full-duplex = listens and speaks simultaneously (no turn-taking).
 *
 * Backend priority:
 * 1. moshi-mlx    — Mac Apple Silicon + MLX installed + moshi Python package installed
 * 2. moshi-cpu    — moshi Python package installed (any platform, slower)
 * 3. whisper-kokoro — always available (current Whisper STT + TTS stack)
 * 4. nim-api      — NVIDIA_NIM_KEY env var set
 * 5. web-speech   — browser environments only
 */

import { execSync } from "child_process";

export type VoiceBackend =
  | "moshi-mlx"
  | "moshi-cpu"
  | "whisper-kokoro"
  | "nim-api"
  | "web-speech";

export interface FullDuplexProvider {
  readonly name: VoiceBackend;
  isAvailable(): Promise<boolean>;
  /** Stream audio buffers in, receive audio response buffers simultaneously */
  stream(audioIn: AsyncIterable<Buffer>): AsyncIterable<Buffer>;
  /** Optional: set persona via text prompt + optional voice audio sample */
  setPersona?(textPrompt: string, voicePrompt?: Buffer): Promise<void>;
}

export interface BackendCapabilities {
  /** True if running on Apple Silicon (darwin + arm64) */
  hasAppleSilicon: boolean;
  /** True if MLX Python package is importable */
  hasMLX: boolean;
  /** True if moshi Python package is importable */
  hasMoshiInstalled: boolean;
  /** True if CUDA is available (nvidia-smi succeeds) */
  hasCUDA: boolean;
  /** True if NVIDIA_NIM_KEY env var is set */
  hasNIMKey: boolean;
  platform: NodeJS.Platform;
  arch: string;
}

function tryExec(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<BackendCapabilities> {
  const platform = process.platform;
  const arch = process.arch;
  const hasAppleSilicon = platform === "darwin" && arch === "arm64";

  const hasMLX = hasAppleSilicon && tryExec("python3 -c \"import mlx\"");
  const hasMoshiInstalled = tryExec("python3 -c \"import moshi\"");
  const hasCUDA = tryExec("nvidia-smi");
  const hasNIMKey = !!process.env.NVIDIA_NIM_KEY;

  return {
    hasAppleSilicon,
    hasMLX,
    hasMoshiInstalled,
    hasCUDA,
    hasNIMKey,
    platform,
    arch,
  };
}

export async function selectBestBackend(
  caps: BackendCapabilities
): Promise<VoiceBackend> {
  if (caps.hasAppleSilicon && caps.hasMLX && caps.hasMoshiInstalled) {
    return "moshi-mlx";
  }
  if (caps.hasMoshiInstalled) {
    return "moshi-cpu";
  }
  if (caps.hasNIMKey) {
    return "nim-api";
  }
  // whisper-kokoro is always available — it's the current Whisper STT + macOS TTS stack
  return "whisper-kokoro";
}
