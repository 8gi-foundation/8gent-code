/**
 * 8gent Code - Per-Tab Agent Hook
 *
 * Owns one Agent instance per chat tab so Orchestrator, Engineer, and QA
 * can run simultaneously across different inference engines (Ollama, LM
 * Studio, apfel) without blocking each other on a single global isProcessing
 * flag.
 *
 * Lifecycle:
 *  - getOrCreateAgent(tabId, ...) is called the first time a tab submits.
 *    The Agent is constructed with that tab's role config (provider/model)
 *    pulled from ROLE_REGISTRY plus any overrides from
 *    ~/.8gent/settings.json.
 *  - removeTabAgent(tabId) is called when a tab is closed. The in-flight
 *    Agent is aborted and dropped from the map.
 *  - isTabProcessing(tabId) reflects whether that tab currently has an
 *    in-flight chat() call. The TabBar reads this to render an inline
 *    indicator on each busy tab.
 *
 * The hook deliberately does not own message storage. The host app keeps
 * tabMessagesRef as the source of truth and decides when to mirror to the
 * foreground via setMessagesRaw. This hook only cares about:
 *  - which tab has an Agent
 *  - which tab is currently processing
 *  - which AbortController belongs to which tab (via Agent.abort)
 */

import { useCallback, useRef, useState } from "react";
import { Agent } from "../../../../packages/eight/index.js";
import type { AgentEventCallbacks } from "../../../../packages/eight/index.js";
import { ROLE_REGISTRY } from "../../../../packages/orchestration/role-registry.js";
import { loadSettings as loadAppSettings } from "../../../../packages/settings/index.js";

// ============================================
// Types
// ============================================

export type TabAgentRuntime = "ollama" | "lmstudio" | "openrouter";

export interface TabAgentSpec {
	/** Provider id as used by the TUI (e.g. "ollama", "lmstudio", "apfel", "openrouter-free"). */
	provider: string;
	/** Model id understood by that provider. */
	model: string;
	/** Optional role hint - used for logging/diagnostics. */
	role?: string;
}

export interface CreateAgentOptions extends TabAgentSpec {
	/** Working directory for the agent's tools. */
	workingDirectory: string;
	/** Event callbacks scoped to this tab. */
	events: AgentEventCallbacks;
	/** Optional API key (for OpenRouter etc.). */
	apiKey?: string;
	/** Optional max-turns override. */
	maxTurns?: number;
}

// ============================================
// Helpers
// ============================================

/** Map a TUI provider id to the runtime literal that AgentConfig understands. */
function toAgentRuntime(provider: string): TabAgentRuntime {
	if (provider === "lmstudio") return "lmstudio";
	if (provider === "openrouter" || provider === "openrouter-free") return "openrouter";
	// apfel, ollama, and any unknown provider fall through to ollama runtime;
	// apfel is OpenAI-compatible and the existing Agent treats it via its own
	// adapter chain - matching what app.tsx did before this hook landed.
	if (provider === "apfel") return "ollama";
	return "ollama";
}

/** Resolve provider/model for a chat tab: per-tab settings override -> ROLE_REGISTRY default. */
export function resolveSpecForRole(role: string | undefined): TabAgentSpec | null {
	if (!role) return null;

	// Per-tab settings override (matches the precedence already used in app.tsx
	// for the active-tab provider/model swap).
	try {
		const s = loadAppSettings();
		const tabsMap = s?.models?.tabs as unknown as Record<
			string,
			{ provider?: string; model?: string }
		>;
		const tabSettings = tabsMap?.[role];
		if (tabSettings?.provider && tabSettings?.model) {
			return { provider: tabSettings.provider, model: tabSettings.model, role };
		}
	} catch {
		// Fall through to ROLE_REGISTRY default
	}

	const cfg = ROLE_REGISTRY[role];
	if (!cfg?.inferenceMode || !cfg?.model) return null;
	return { provider: cfg.inferenceMode, model: cfg.model, role };
}

// ============================================
// Hook
// ============================================

export function usePerTabAgents() {
	const agentsRef = useRef<Map<string, Agent>>(new Map());
	// Promise registry for Ctrl+G background-divert: tab id -> in-flight chat promise.
	const promisesRef = useRef<Map<string, Promise<string>>>(new Map());
	const labelsRef = useRef<Map<string, string>>(new Map());

	// Reactive map driving UI - one boolean per tab id.
	const [processingMap, setProcessingMap] = useState<Record<string, boolean>>({});

	const setTabProcessing = useCallback((tabId: string, value: boolean) => {
		setProcessingMap((prev) => {
			if (Boolean(prev[tabId]) === value) return prev;
			const next = { ...prev };
			if (value) next[tabId] = true;
			else delete next[tabId];
			return next;
		});
	}, []);

	const isTabProcessing = useCallback(
		(tabId: string) => Boolean(processingMap[tabId]),
		[processingMap],
	);

	const getAgent = useCallback((tabId: string): Agent | null => {
		return agentsRef.current.get(tabId) ?? null;
	}, []);

	const setAgent = useCallback((tabId: string, agent: Agent) => {
		agentsRef.current.set(tabId, agent);
	}, []);

	/** Lazily build an Agent for this tab if it doesn't exist yet. */
	const getOrCreateAgent = useCallback(
		async (tabId: string, opts: CreateAgentOptions): Promise<Agent | null> => {
			const existing = agentsRef.current.get(tabId);
			if (existing) return existing;

			try {
				const newAgent = new Agent({
					model: opts.model,
					runtime: toAgentRuntime(opts.provider),
					workingDirectory: opts.workingDirectory,
					maxTurns: opts.maxTurns ?? 50,
					apiKey: opts.apiKey,
					events: opts.events,
				});
				const ready = await newAgent.isReady();
				if (!ready) {
					// Surface readiness to caller; do not cache an unusable agent.
					return null;
				}
				agentsRef.current.set(tabId, newAgent);
				return newAgent;
			} catch {
				return null;
			}
		},
		[],
	);

	/** Abort the tab's in-flight chat (if any). Does not drop the Agent. */
	const abortTab = useCallback((tabId: string) => {
		const a = agentsRef.current.get(tabId);
		if (a) {
			try {
				a.abort();
			} catch {
				// best-effort
			}
		}
	}, []);

	/** Abort + drop the Agent for this tab. Called when a tab is closed. */
	const removeTabAgent = useCallback(
		(tabId: string) => {
			abortTab(tabId);
			const a = agentsRef.current.get(tabId);
			agentsRef.current.delete(tabId);
			promisesRef.current.delete(tabId);
			labelsRef.current.delete(tabId);
			setProcessingMap((prev) => {
				if (!(tabId in prev)) return prev;
				const next = { ...prev };
				delete next[tabId];
				return next;
			});
			// Best-effort cleanup; do not block tab removal on it.
			if (a) {
				try {
					a.cleanup().catch(() => {});
				} catch {
					// ignore
				}
			}
		},
		[abortTab],
	);

	const trackPromise = useCallback((tabId: string, promise: Promise<string>, label: string) => {
		promisesRef.current.set(tabId, promise);
		labelsRef.current.set(tabId, label.slice(0, 80));
	}, []);

	const getPromise = useCallback((tabId: string): Promise<string> | null => {
		return promisesRef.current.get(tabId) ?? null;
	}, []);

	const getLabel = useCallback((tabId: string): string => {
		return labelsRef.current.get(tabId) ?? "";
	}, []);

	const clearPromise = useCallback((tabId: string) => {
		promisesRef.current.delete(tabId);
		labelsRef.current.delete(tabId);
	}, []);

	return {
		// state
		processingMap,
		isTabProcessing,
		setTabProcessing,
		// agent registry
		getAgent,
		setAgent,
		getOrCreateAgent,
		abortTab,
		removeTabAgent,
		// foreground promise registry (used by Ctrl+G background-divert)
		trackPromise,
		getPromise,
		getLabel,
		clearPromise,
	};
}
