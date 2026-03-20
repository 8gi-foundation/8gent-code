/**
 * useVoiceChat — React hook for voice chat mode in the TUI.
 *
 * Wraps VoiceChatLoop with React state and keyboard interrupt (ESC to stop).
 * Half-duplex: listen -> transcribe -> agent -> speak -> listen.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useInput } from "ink";
import { VoiceChatLoop, type VoiceChatState, VoiceEngine } from "@8gent/voice";

export interface UseVoiceChatOptions {
  /** Send message to agent, return response text */
  onAgentMessage: (transcript: string) => Promise<string>;
  /** Voice name for TTS (default: Daniel) */
  voice?: string;
  /** Silence duration before auto-stop (ms, default: 1500) */
  silenceMs?: number;
  /** Called when voice chat starts/stops */
  onActiveChange?: (active: boolean) => void;
}

export interface UseVoiceChatReturn {
  /** Current voice chat state */
  state: VoiceChatState;
  /** Whether voice chat is active */
  isActive: boolean;
  /** Last thing the user said */
  lastUserSaid: string | null;
  /** Last thing the agent said */
  lastAgentSaid: string | null;
  /** Error message if any */
  error: string | null;
  /** Start voice chat mode */
  start: () => Promise<void>;
  /** Stop voice chat mode */
  stop: () => Promise<void>;
  /** Interrupt agent mid-speech */
  interrupt: () => Promise<void>;
}

export function useVoiceChat(options: UseVoiceChatOptions): UseVoiceChatReturn {
  const [state, setState] = useState<VoiceChatState>("idle");
  const [isActive, setIsActive] = useState(false);
  const [lastUserSaid, setLastUserSaid] = useState<string | null>(null);
  const [lastAgentSaid, setLastAgentSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loopRef = useRef<VoiceChatLoop | null>(null);
  const engineRef = useRef<VoiceEngine | null>(null);

  // ESC key interrupts speech or stops voice chat
  useInput(
    (input, key) => {
      if (!isActive) return;

      if (key.escape) {
        if (state === "speaking") {
          // Interrupt mid-speech, keep chatting
          loopRef.current?.interrupt();
        } else {
          // Stop voice chat entirely
          stop();
        }
      }
    },
    { isActive }
  );

  const start = useCallback(async () => {
    if (isActive) return;

    // Create engine if needed
    if (!engineRef.current) {
      engineRef.current = new VoiceEngine({ model: "tiny" });
    }

    const engine = engineRef.current;
    const available = await engine.isAvailable();
    if (!available) {
      setError("Voice not available. Install sox and whisper.cpp: brew install sox whisper-cpp");
      return;
    }

    const loop = new VoiceChatLoop({
      engine,
      onMessage: options.onAgentMessage,
      voice: options.voice ?? "Daniel",
      silenceMs: options.silenceMs ?? 1500,
      onStateChange: (newState, detail) => {
        setState(newState);
      },
      onError: (msg) => {
        setError(msg);
        setTimeout(() => setError(null), 5000);
      },
    });

    loop.on("user-said", (text) => setLastUserSaid(text));
    loop.on("agent-said", (text) => setLastAgentSaid(text));
    loop.on("stopped", () => {
      setIsActive(false);
      options.onActiveChange?.(false);
    });

    loopRef.current = loop;
    setIsActive(true);
    setError(null);
    options.onActiveChange?.(true);

    // Start the loop (runs in background)
    loop.start().catch((err) => {
      setError(err.message);
      setIsActive(false);
    });
  }, [isActive, options]);

  const stop = useCallback(async () => {
    if (loopRef.current) {
      await loopRef.current.stop();
      loopRef.current = null;
    }
    setIsActive(false);
    setState("idle");
    options.onActiveChange?.(false);
  }, [options]);

  const interrupt = useCallback(async () => {
    if (loopRef.current) {
      await loopRef.current.interrupt();
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      loopRef.current?.stop().catch(() => {});
      engineRef.current?.destroy().catch(() => {});
    };
  }, []);

  return {
    state,
    isActive,
    lastUserSaid,
    lastAgentSaid,
    error,
    start,
    stop,
    interrupt,
  };
}
