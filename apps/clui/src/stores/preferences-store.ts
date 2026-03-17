/**
 * 8gent CLUI -- Preferences Store (Zustand)
 *
 * Local-first preferences with optional Convex sync when authenticated.
 * Merge strategy: local always wins, cloud syncs asynchronously.
 *
 * Persisted to localStorage. Synced to Convex on auth state change.
 */

import { create } from "zustand";

// ── Types ────────────────────────────────────────────────────────────

export type ThemeMode = "dark" | "light" | "system";

export type ModelProvider = "ollama" | "openrouter" | "lmstudio" | "custom";

export interface ModelConfig {
  provider: ModelProvider;
  modelId: string;
  label: string;
  endpoint?: string;
  apiKey?: string;
}

export interface UsageStats {
  totalSessions: number;
  totalTokens: number;
  totalToolCalls: number;
  totalDurationMs: number;
  lastSessionAt: number | null;
}

export interface PreferencesStore {
  // Theme
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;

  // Model
  activeModel: ModelConfig;
  savedModels: ModelConfig[];
  setActiveModel: (model: ModelConfig) => void;
  addSavedModel: (model: ModelConfig) => void;
  removeSavedModel: (modelId: string) => void;

  // UI
  showEvidencePanel: boolean;
  showKanban: boolean;
  showSettings: boolean;
  toggleEvidencePanel: () => void;
  toggleKanban: () => void;
  toggleSettings: () => void;

  // Usage (populated from Convex when authenticated)
  usage: UsageStats;
  setUsage: (usage: Partial<UsageStats>) => void;

  // Sync
  lastSyncedAt: number | null;
  markSynced: () => void;

  // Persistence
  hydrate: () => void;
  persist: () => void;
}

// ── Default Values ──────────────────────────────────────────────────

const DEFAULT_MODEL: ModelConfig = {
  provider: "ollama",
  modelId: "qwen3.5",
  label: "Qwen 3.5 (Ollama)",
};

const PRESET_MODELS: ModelConfig[] = [
  DEFAULT_MODEL,
  { provider: "ollama", modelId: "llama3.2", label: "Llama 3.2 (Ollama)" },
  { provider: "ollama", modelId: "deepseek-r1", label: "DeepSeek R1 (Ollama)" },
  { provider: "ollama", modelId: "codestral", label: "Codestral (Ollama)" },
  { provider: "openrouter", modelId: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4 (OpenRouter)" },
  { provider: "openrouter", modelId: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (OpenRouter)" },
  { provider: "lmstudio", modelId: "default", label: "LM Studio (localhost)" },
];

const DEFAULT_USAGE: UsageStats = {
  totalSessions: 0,
  totalTokens: 0,
  totalToolCalls: 0,
  totalDurationMs: 0,
  lastSessionAt: null,
};

const STORAGE_KEY = "8gent-clui-preferences";

// ── Helpers ─────────────────────────────────────────────────────────

function loadFromStorage(): Partial<PreferencesStore> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveToStorage(state: Partial<PreferencesStore>) {
  try {
    const serializable = {
      theme: state.theme,
      activeModel: state.activeModel,
      savedModels: state.savedModels,
      showEvidencePanel: state.showEvidencePanel,
      showKanban: state.showKanban,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // localStorage may be full or unavailable
  }
}

// ── Store ─────────────────────────────────────────────────────────────

export const usePreferencesStore = create<PreferencesStore>((set, get) => ({
  // Theme
  theme: "dark",
  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme);
    get().persist();
  },

  // Model
  activeModel: DEFAULT_MODEL,
  savedModels: PRESET_MODELS,
  setActiveModel: (model) => {
    set({ activeModel: model });
    get().persist();
  },
  addSavedModel: (model) => {
    set((s) => ({
      savedModels: [...s.savedModels.filter((m) => m.modelId !== model.modelId), model],
    }));
    get().persist();
  },
  removeSavedModel: (modelId) => {
    set((s) => ({
      savedModels: s.savedModels.filter((m) => m.modelId !== modelId),
    }));
    get().persist();
  },

  // UI
  showEvidencePanel: false,
  showKanban: false,
  showSettings: false,
  toggleEvidencePanel: () => set((s) => ({ showEvidencePanel: !s.showEvidencePanel })),
  toggleKanban: () => set((s) => ({ showKanban: !s.showKanban })),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),

  // Usage
  usage: DEFAULT_USAGE,
  setUsage: (usage) => set((s) => ({ usage: { ...s.usage, ...usage } })),

  // Sync
  lastSyncedAt: null,
  markSynced: () => set({ lastSyncedAt: Date.now() }),

  // Persistence
  hydrate: () => {
    const stored = loadFromStorage();
    const updates: Partial<PreferencesStore> = {};

    if (stored.theme) updates.theme = stored.theme as ThemeMode;
    if (stored.activeModel) updates.activeModel = stored.activeModel as ModelConfig;
    if (stored.savedModels) updates.savedModels = stored.savedModels as ModelConfig[];
    if (stored.showEvidencePanel !== undefined) updates.showEvidencePanel = stored.showEvidencePanel as boolean;
    if (stored.showKanban !== undefined) updates.showKanban = stored.showKanban as boolean;

    set(updates);

    // Apply theme on hydration
    if (updates.theme) {
      applyTheme(updates.theme);
    }
  },

  persist: () => {
    const state = get();
    saveToStorage(state);
  },
}));

// ── Theme Application ────────────────────────────────────────────────

function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  root.classList.remove("dark", "light");
  root.classList.add(resolved);
}
