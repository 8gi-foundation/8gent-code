/**
 * useVoiceChat — React hook for voice chat mode in the TUI.
 *
 * Wraps VoiceChatLoop with React state and keyboard interrupt (ESC to stop).
 * Auto-detects best available backend via selectBestBackend():
 *   - moshi-mlx / moshi-cpu: full-duplex streaming (Moshi model required)
 *   - whisper-kokoro: half-duplex listen → STT → agent → TTS (default, no extra deps)
 */

import {
	type VoiceBackend,
	VoiceChatLoop,
	type VoiceChatState,
	VoiceEngine,
	detectCapabilities,
	selectBestBackend,
} from "@8gent/voice";
import { useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

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
	/** Active voice backend (detected on start) */
	backend: VoiceBackend | null;
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
	const [backend, setBackend] = useState<VoiceBackend | null>(null);

	const loopRef = useRef<VoiceChatLoop | null>(null);
	const engineRef = useRef<VoiceEngine | null>(null);

	// ESC key interrupts speech or stops voice chat
	// IMPORTANT: Always active but only acts on ESC — lets all other keys flow through
	useInput((input, key) => {
		if (!isActive || !key.escape) return;

		if (state === "speaking") {
			loopRef.current?.interrupt();
		} else {
			stop();
		}
	});

	const start = useCallback(async () => {
		if (isActive) return;

		// Detect best backend for this machine
		const caps = await detectCapabilities();
		const selectedBackend = await selectBestBackend(caps);
		setBackend(selectedBackend);

		// Create whisper engine if needed (used for whisper-kokoro and as moshi fallback)
		if (!engineRef.current) {
			engineRef.current = new VoiceEngine({ model: "tiny" });
		}

		const engine = engineRef.current;
		const available = await engine.isAvailable();
		if (!available) {
			setError(
				"Voice not available. Install sox and whisper.cpp: brew install sox whisper-cpp",
			);
			return;
		}

		// TODO: When moshi model is downloaded, route moshi-mlx / moshi-cpu backends
		// through MoshiMLXProvider full-duplex streaming instead of VoiceChatLoop.
		// For now, all backends fall through to whisper-kokoro (VoiceChatLoop).
		// Track: packages/voice/backends/moshi-mlx.ts — MoshiMLXProvider

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
		backend,
		start,
		stop,
		interrupt,
	};
}
