/**
 * @8gent/voice — TTS Provider Abstraction Layer
 *
 * Pluggable TTS engine supporting multiple providers:
 * - macOS `say` command (built-in, zero deps)
 * - KittenTTS (local neural TTS via Python)
 * - ElevenLabs (future, placeholder)
 *
 * Uses Bun.spawn for non-blocking subprocess management.
 */

// ============================================
// Types
// ============================================

export interface TTSSpeakOptions {
  voice?: string;
  /** Words per minute */
  rate?: number;
  /** Volume 0-1 (provider-dependent support) */
  volume?: number;
}

export interface TTSProcess {
  kill: () => void;
  exited: Promise<number>;
}

export type TTSProviderName = "macos" | "kitten" | "elevenlabs";

export interface TTSProvider {
  name: string;
  speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess>;
  interrupt(): Promise<void>;
  isAvailable(): Promise<boolean>;
  voices(): string[];
}

// ============================================
// MacOS TTS Provider
// ============================================

export class MacOSTTSProvider implements TTSProvider {
  readonly name = "macos";
  private currentProcess: ReturnType<typeof Bun.spawn> | null = null;

  async speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess> {
    const voice = options?.voice ?? "Ava";
    const rate = options?.rate ?? 200;
    const safe = text.slice(0, 2000);

    const args = ["say", "-v", voice, "-r", String(rate), safe];
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    this.currentProcess = proc;

    return {
      kill: () => {
        try { proc.kill(); } catch {}
        this.currentProcess = null;
      },
      exited: proc.exited.then((code) => {
        if (this.currentProcess === proc) this.currentProcess = null;
        return code;
      }),
    };
  }

  async interrupt(): Promise<void> {
    if (this.currentProcess) {
      try { this.currentProcess.kill(); } catch {}
      this.currentProcess = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "say"], { stdout: "pipe", stderr: "ignore" });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  voices(): string[] {
    return ["Ava", "Daniel", "Moira", "Samantha", "Alex"];
  }
}

// ============================================
// KittenTTS Provider (Local Neural)
// ============================================

export class KittenTTSProvider implements TTSProvider {
  readonly name = "kitten";
  private currentProcess: ReturnType<typeof Bun.spawn> | null = null;
  private static readonly MODEL = "KittenML/kitten-tts-nano-0.8";

  async speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess> {
    const voice = options?.voice ?? "Bruno";
    const outPath = `/tmp/kitten-out-${Date.now()}.wav`;

    // Escape text for Python string literal
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").slice(0, 2000);

    const script = [
      `from kittentts import KittenTTS`,
      `m = KittenTTS("${KittenTTSProvider.MODEL}")`,
      `m.generate_to_file("${escaped}", "${outPath}", voice="${voice}")`,
      `import subprocess`,
      `subprocess.run(["afplay", "${outPath}"])`,
      `import os`,
      `os.remove("${outPath}")`,
    ].join("; ");

    const proc = Bun.spawn(["python3", "-c", script], {
      stdout: "ignore",
      stderr: "ignore",
    });
    this.currentProcess = proc;

    return {
      kill: () => {
        try { proc.kill(); } catch {}
        // Also kill afplay in case it's playing the generated audio
        try { Bun.spawn(["killall", "afplay"], { stdout: "ignore", stderr: "ignore" }); } catch {}
        this.currentProcess = null;
      },
      exited: proc.exited.then((code) => {
        if (this.currentProcess === proc) this.currentProcess = null;
        return code;
      }),
    };
  }

  async interrupt(): Promise<void> {
    if (this.currentProcess) {
      try { this.currentProcess.kill(); } catch {}
      this.currentProcess = null;
    }
    // Kill any lingering afplay from kitten output
    try { Bun.spawn(["killall", "afplay"], { stdout: "ignore", stderr: "ignore" }); } catch {}
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["python3", "-c", "import kittentts"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  voices(): string[] {
    return ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"];
  }
}

// ============================================
// TTSEngine — orchestrator with fallback
// ============================================

const PROVIDERS: Record<TTSProviderName, () => TTSProvider> = {
  macos: () => new MacOSTTSProvider(),
  kitten: () => new KittenTTSProvider(),
  elevenlabs: () => {
    // Placeholder — not yet implemented
    throw new Error("ElevenLabs TTS provider not yet implemented");
  },
};

export class TTSEngine {
  private preferred: TTSProviderName;
  private providerCache: Map<TTSProviderName, TTSProvider> = new Map();
  private resolvedProvider: TTSProvider | null = null;

  constructor(preferred: TTSProviderName = "macos") {
    this.preferred = preferred;
  }

  /**
   * Get the active provider. Returns preferred if available, falls back to macos.
   */
  async getProvider(): Promise<TTSProvider> {
    if (this.resolvedProvider) return this.resolvedProvider;

    // Try preferred first
    const pref = this.getOrCreateProvider(this.preferred);
    if (pref && (await pref.isAvailable())) {
      this.resolvedProvider = pref;
      return pref;
    }

    // Fallback to macos
    if (this.preferred !== "macos") {
      const fallback = this.getOrCreateProvider("macos");
      if (fallback && (await fallback.isAvailable())) {
        this.resolvedProvider = fallback;
        return fallback;
      }
    }

    // Last resort: return macos anyway (speak will just fail gracefully)
    const macos = this.getOrCreateProvider("macos");
    this.resolvedProvider = macos;
    return macos;
  }

  private getOrCreateProvider(name: TTSProviderName): TTSProvider {
    let provider = this.providerCache.get(name);
    if (!provider) {
      try {
        provider = PROVIDERS[name]();
        this.providerCache.set(name, provider);
      } catch {
        // If provider construction fails (e.g. elevenlabs), fall through
        provider = new MacOSTTSProvider();
      }
    }
    return provider;
  }

  /**
   * Speak text using the active provider.
   */
  async speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess> {
    const provider = await this.getProvider();
    return provider.speak(text, options);
  }

  /**
   * Interrupt any currently playing speech.
   */
  async interrupt(): Promise<void> {
    const provider = await this.getProvider();
    return provider.interrupt();
  }

  /**
   * Get the name of the active provider.
   */
  async getProviderName(): Promise<string> {
    const provider = await this.getProvider();
    return provider.name;
  }

  /**
   * List voices for the active provider.
   */
  async voices(): Promise<string[]> {
    const provider = await this.getProvider();
    return provider.voices();
  }

  /**
   * Switch preferred provider. Clears resolved cache to re-evaluate.
   */
  setPreferred(name: TTSProviderName): void {
    this.preferred = name;
    this.resolvedProvider = null;
  }
}

// ============================================
// Singleton
// ============================================

let _engine: TTSEngine | null = null;

/**
 * Get the global TTS engine singleton.
 */
export function getTTSEngine(): TTSEngine {
  if (!_engine) {
    _engine = new TTSEngine();
  }
  return _engine;
}

/**
 * Replace the global TTS engine singleton.
 */
export function setTTSEngine(engine: TTSEngine): void {
  _engine = engine;
}
