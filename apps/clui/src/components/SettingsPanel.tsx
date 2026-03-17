/**
 * 8gent CLUI -- Settings Panel Component
 *
 * Full-screen overlay for app settings. Toggle with Cmd+, (comma).
 *
 * Sections:
 * - Model selection (Ollama, OpenRouter, LM Studio)
 * - Theme toggle (dark / light / system)
 * - Auth status and account info
 * - Usage stats (from Convex when authenticated)
 * - Keyboard shortcuts reference
 *
 * Color rules: uses only CSS custom properties from tokens.css
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuthStore } from "../stores/auth-store";
import {
  usePreferencesStore,
  type ThemeMode,
  type ModelConfig,
} from "../stores/preferences-store";

// ── Props ─────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

// ── Section IDs ───────────────────────────────────────────────────────

type SectionId = "model" | "theme" | "auth" | "usage" | "shortcuts";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "theme", label: "Theme" },
  { id: "auth", label: "Account" },
  { id: "usage", label: "Usage" },
  { id: "shortcuts", label: "Shortcuts" },
];

// ── Main Component ────────────────────────────────────────────────────

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("model");

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="
            fixed inset-0 z-40
            flex items-center justify-center
            bg-[var(--overlay-bg)]
          "
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.97, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="
              bg-surface-primary border border-subtle rounded-lg
              w-[540px] max-h-[480px]
              flex overflow-hidden
              shadow-xl
            "
          >
            {/* Sidebar */}
            <div className="w-36 bg-surface-secondary border-r border-subtle flex flex-col py-2">
              <div className="px-3 py-1.5 mb-2">
                <span className="text-accent font-bold text-xs">Settings</span>
              </div>
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`
                    px-3 py-1.5 text-left text-xs transition-colors duration-100
                    ${activeSection === section.id
                      ? "bg-surface-elevated text-accent font-bold border-l-2 border-accent"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-elevated/50 border-l-2 border-transparent"
                    }
                  `}
                >
                  {section.label}
                </button>
              ))}

              {/* Close hint */}
              <div className="mt-auto px-3 py-2">
                <span className="text-muted text-[10px]">
                  Esc or Cmd+, to close
                </span>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {activeSection === "model" && <ModelSection />}
              {activeSection === "theme" && <ThemeSection />}
              {activeSection === "auth" && <AuthSection />}
              {activeSection === "usage" && <UsageSection />}
              {activeSection === "shortcuts" && <ShortcutsSection />}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Model Section ─────────────────────────────────────────────────────

function ModelSection() {
  const activeModel = usePreferencesStore((s) => s.activeModel);
  const savedModels = usePreferencesStore((s) => s.savedModels);
  const setActiveModel = usePreferencesStore((s) => s.setActiveModel);

  // Group models by provider
  const grouped = savedModels.reduce<Record<string, ModelConfig[]>>(
    (acc, model) => {
      if (!acc[model.provider]) acc[model.provider] = [];
      acc[model.provider].push(model);
      return acc;
    },
    {},
  );

  const providerLabels: Record<string, string> = {
    ollama: "Ollama (Local)",
    openrouter: "OpenRouter (Cloud)",
    lmstudio: "LM Studio (Local)",
    custom: "Custom Endpoint",
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Model Selection" description="Choose the LLM model for agent sessions." />

      {Object.entries(grouped).map(([provider, models]) => (
        <div key={provider}>
          <h4 className="text-text-secondary text-[10px] font-bold uppercase tracking-wider mb-1.5">
            {providerLabels[provider] || provider}
          </h4>
          <div className="space-y-1">
            {models.map((model) => {
              const isActive = model.modelId === activeModel.modelId && model.provider === activeModel.provider;
              return (
                <button
                  key={`${model.provider}-${model.modelId}`}
                  onClick={() => setActiveModel(model)}
                  className={`
                    w-full flex items-center justify-between
                    px-3 py-1.5 rounded text-xs text-left
                    transition-colors duration-100
                    ${isActive
                      ? "bg-accent/10 text-accent border border-accent/30"
                      : "text-text-primary hover:bg-surface-elevated border border-transparent"
                    }
                  `}
                >
                  <span>{model.label}</span>
                  {isActive && (
                    <span className="text-accent text-[10px]">&check;</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Theme Section ─────────────────────────────────────────────────────

function ThemeSection() {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);

  const options: { value: ThemeMode; label: string; description: string }[] = [
    { value: "dark", label: "Dark", description: "Dark background with cyan accents" },
    { value: "light", label: "Light", description: "Light background with blue accents" },
    { value: "system", label: "System", description: "Follow OS appearance setting" },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader title="Theme" description="Choose the appearance mode." />

      <div className="space-y-1.5">
        {options.map((opt) => {
          const isActive = theme === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={`
                w-full flex items-center justify-between
                px-3 py-2 rounded text-left
                transition-colors duration-100
                ${isActive
                  ? "bg-accent/10 text-accent border border-accent/30"
                  : "text-text-primary hover:bg-surface-elevated border border-transparent"
                }
              `}
            >
              <div>
                <div className="text-xs font-bold">{opt.label}</div>
                <div className="text-[10px] text-muted mt-0.5">{opt.description}</div>
              </div>
              {isActive && (
                <span className="text-accent text-sm">&check;</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Auth Section ──────────────────────────────────────────────────────

function AuthSection() {
  const stateName = useAuthStore((s) => s.stateName);
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const isLoading = useAuthStore((s) => s.isLoading);

  return (
    <div className="space-y-4">
      <SectionHeader title="Account" description="Authentication and account status." />

      {stateName === "authenticated" && user ? (
        <div className="space-y-3">
          {/* User info card */}
          <div className="flex items-center gap-3 px-3 py-3 rounded bg-surface-secondary border border-subtle">
            {user.avatar ? (
              <img
                src={user.avatar}
                alt={user.displayName}
                className="w-8 h-8 rounded-full border border-accent/30"
              />
            ) : (
              <span className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-sm text-accent font-bold">
                {user.displayName.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-text-primary text-xs font-bold truncate">
                {user.displayName}
              </div>
              <div className="text-muted text-[10px] truncate">{user.email}</div>
              {user.githubUsername && (
                <div className="text-text-secondary text-[10px]">
                  @{user.githubUsername}
                </div>
              )}
            </div>
            <span
              className={`
                text-[10px] px-1.5 py-0.5 rounded border
                ${user.plan === "pro"
                  ? "text-brand border-8-magenta/40"
                  : user.plan === "team"
                    ? "text-accent border-accent/40"
                    : "text-muted border-subtle"
                }
              `}
            >
              {user.plan}
            </span>
          </div>

          {/* Logout */}
          <button
            onClick={() => logout()}
            disabled={isLoading}
            className="
              w-full px-3 py-1.5 rounded text-xs
              text-danger border border-danger/30
              hover:bg-danger/10
              transition-colors duration-100
              disabled:opacity-50
            "
          >
            {isLoading ? "Signing out..." : "Sign out"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="px-3 py-3 rounded bg-surface-secondary border border-subtle text-center">
            <div className="text-muted text-xs mb-2">Not signed in</div>
            <p className="text-text-secondary text-[10px] mb-3">
              Sign in to sync sessions, preferences, and usage stats across devices.
            </p>
            <button
              onClick={() => login()}
              disabled={isLoading}
              className="
                px-4 py-1.5 rounded text-xs
                text-accent border border-accent/30
                hover:bg-accent/10
                transition-colors duration-100
                disabled:opacity-50
              "
            >
              {isLoading ? "Signing in..." : "Sign in with GitHub"}
            </button>
          </div>

          <p className="text-muted text-[10px] text-center">
            All features work without an account. Auth is optional.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Usage Section ─────────────────────────────────────────────────────

function UsageSection() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const usage = usePreferencesStore((s) => s.usage);

  const formatNumber = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const formatDuration = (ms: number): string => {
    const hours = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Usage Stats"
        description={
          isAuthenticated
            ? "Aggregated from Convex."
            : "Sign in to sync usage across devices."
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <UsageStat label="Sessions" value={formatNumber(usage.totalSessions)} />
        <UsageStat label="Tokens" value={formatNumber(usage.totalTokens)} />
        <UsageStat label="Tool Calls" value={formatNumber(usage.totalToolCalls)} />
        <UsageStat label="Total Time" value={formatDuration(usage.totalDurationMs)} />
      </div>

      {usage.lastSessionAt && (
        <div className="text-muted text-[10px]">
          Last session: {new Date(usage.lastSessionAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded bg-surface-secondary border border-subtle">
      <div className="text-muted text-[10px]">{label}</div>
      <div className="text-accent text-sm font-bold">{value}</div>
    </div>
  );
}

// ── Shortcuts Section ─────────────────────────────────────────────────

function ShortcutsSection() {
  const shortcuts = [
    { key: "Cmd+T", action: "New session tab" },
    { key: "Cmd+W", action: "Close current tab" },
    { key: "Cmd+1-9", action: "Switch to tab by number" },
    { key: "Cmd+K", action: "Toggle plan kanban" },
    { key: "Cmd+E", action: "Toggle evidence panel" },
    { key: "Cmd+,", action: "Open settings" },
    { key: "Escape", action: "Close overlay / panel" },
    { key: "Enter", action: "Send message" },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader title="Keyboard Shortcuts" description="Quick reference for available shortcuts." />

      <div className="space-y-0.5">
        {shortcuts.map((s) => (
          <div
            key={s.key}
            className="flex items-center justify-between px-3 py-1.5 rounded hover:bg-surface-elevated/50 transition-colors"
          >
            <span className="text-text-primary text-xs">{s.action}</span>
            <kbd className="
              px-1.5 py-0.5 rounded
              bg-surface-secondary border border-subtle
              text-accent text-[10px] font-mono
            ">
              {s.key}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared Components ─────────────────────────────────────────────────

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3">
      <h3 className="text-text-primary text-sm font-bold">{title}</h3>
      <p className="text-muted text-[10px] mt-0.5">{description}</p>
    </div>
  );
}

export default SettingsPanel;
