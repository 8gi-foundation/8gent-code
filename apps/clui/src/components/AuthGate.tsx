/**
 * 8gent CLUI -- Auth Gate Component
 *
 * Non-blocking authentication gate that wraps the app.
 * Always renders children (anonymous mode works).
 * Shows auth status in title bar area and login UI when requested.
 *
 * Features:
 * - If not authenticated: subtle "Sign in" link
 * - If authenticated: user avatar + name badge
 * - Device code flow UI during login
 * - Login/Logout buttons
 * - Anonymous mode: skip auth, show "Anonymous" badge
 *
 * Color rules: uses only CSS custom properties from tokens.css
 */

import React, { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuthStore } from "../stores/auth-store";

// ── Props ─────────────────────────────────────────────────────────────

interface AuthGateProps {
  children: React.ReactNode;
}

// ── Main Component ────────────────────────────────────────────────────

export function AuthGate({ children }: AuthGateProps) {
  const initialize = useAuthStore((s) => s.initialize);
  const stateName = useAuthStore((s) => s.stateName);

  // Initialize auth on mount
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Show loading spinner only on first load
  if (stateName === "unknown") {
    return (
      <div className="h-full flex items-center justify-center bg-surface-primary">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-3"
        >
          <span className="text-3xl text-accent">8</span>
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span
              className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
              style={{ animationDelay: "300ms" }}
            />
          </div>
        </motion.div>
      </div>
    );
  }

  return <>{children}</>;
}

// ── Auth Status Badge (for title bar) ─────────────────────────────────

export function AuthStatusBadge() {
  const stateName = useAuthStore((s) => s.stateName);
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);

  if (stateName === "authenticated" && user) {
    return (
      <div className="flex items-center gap-1.5">
        {/* Avatar */}
        {user.avatar ? (
          <img
            src={user.avatar}
            alt={user.displayName}
            className="w-4 h-4 rounded-full border border-accent/30"
          />
        ) : (
          <span className="w-4 h-4 rounded-full bg-accent/20 flex items-center justify-center text-[8px] text-accent">
            {user.displayName.charAt(0).toUpperCase()}
          </span>
        )}

        {/* Name */}
        <span className="text-text-secondary text-xs truncate max-w-[80px]">
          {user.displayName}
        </span>

        {/* Logout button */}
        <button
          onClick={() => logout()}
          className="
            text-[10px] text-muted hover:text-danger
            transition-colors duration-150
          "
          title="Sign out"
        >
          &times;
        </button>
      </div>
    );
  }

  if (stateName === "logging_in" || isLoading) {
    return (
      <span className="text-accent text-xs animate-pulse">
        Signing in...
      </span>
    );
  }

  // Anonymous mode
  return (
    <button
      onClick={() => login()}
      className="
        text-xs text-muted hover:text-accent
        transition-colors duration-150
      "
    >
      Sign in
    </button>
  );
}

// ── Device Code Overlay ───────────────────────────────────────────────

export function DeviceCodeOverlay() {
  const stateName = useAuthStore((s) => s.stateName);
  const deviceCode = useAuthStore((s) => s.deviceCode);
  const pollAttempt = useAuthStore((s) => s.pollAttempt);
  const skipAuth = useAuthStore((s) => s.skipAuth);

  const isVisible = stateName === "logging_in" && deviceCode !== null;

  const handleCopyCode = useCallback(() => {
    if (deviceCode) {
      navigator.clipboard.writeText(deviceCode.userCode);
    }
  }, [deviceCode]);

  return (
    <AnimatePresence>
      {isVisible && deviceCode && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="
            fixed inset-0 z-50
            flex items-center justify-center
            bg-[var(--overlay-bg)]
          "
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="
              bg-surface-elevated border border-accent/30 rounded-lg
              p-6 max-w-sm w-full mx-4
              shadow-xl
            "
          >
            {/* Header */}
            <div className="text-center mb-4">
              <span className="text-2xl text-accent font-bold">8</span>
              <h2 className="text-text-primary text-sm font-bold mt-1">
                Sign in to 8gent
              </h2>
              <p className="text-muted text-xs mt-1">
                Enter this code in your browser
              </p>
            </div>

            {/* Device code */}
            <button
              onClick={handleCopyCode}
              className="
                w-full py-3 px-4 rounded-lg
                bg-surface-secondary border border-accent/40
                text-accent text-xl font-mono font-bold text-center
                tracking-[0.3em]
                hover:bg-surface-elevated hover:border-accent
                transition-colors duration-150
                cursor-pointer
              "
              title="Click to copy"
            >
              {deviceCode.userCode}
            </button>
            <p className="text-muted text-[10px] text-center mt-1">
              Click to copy
            </p>

            {/* Verification URL */}
            <div className="mt-4 text-center">
              <p className="text-muted text-xs">Open in browser:</p>
              <a
                href={deviceCode.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-info text-xs underline underline-offset-2 hover:text-accent transition-colors"
              >
                {deviceCode.verificationUri}
              </a>
            </div>

            {/* Polling indicator */}
            <div className="mt-4 flex items-center justify-center gap-2">
              <div className="flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-accent animate-pulse" />
                <span
                  className="w-1 h-1 rounded-full bg-accent animate-pulse"
                  style={{ animationDelay: "200ms" }}
                />
                <span
                  className="w-1 h-1 rounded-full bg-accent animate-pulse"
                  style={{ animationDelay: "400ms" }}
                />
              </div>
              <span className="text-muted text-[10px]">
                Waiting for authorization{pollAttempt > 0 ? ` (attempt ${pollAttempt})` : ""}...
              </span>
            </div>

            {/* Skip button */}
            <div className="mt-4 text-center">
              <button
                onClick={skipAuth}
                className="
                  text-xs text-muted hover:text-text-secondary
                  transition-colors duration-150
                "
              >
                Skip -- continue anonymously
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Auth Error Toast ──────────────────────────────────────────────────

export function AuthErrorToast() {
  const stateName = useAuthStore((s) => s.stateName);
  const error = useAuthStore((s) => s.error);
  const skipAuth = useAuthStore((s) => s.skipAuth);

  const isVisible = stateName === "error" && error !== null;

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.2 }}
          className="
            fixed top-10 left-1/2 -translate-x-1/2 z-50
            bg-surface-elevated border border-danger/40 rounded-lg
            px-4 py-2 max-w-sm
            shadow-lg
          "
        >
          <div className="flex items-center gap-2">
            <span className="text-danger text-xs">&times;</span>
            <span className="text-text-primary text-xs">{error}</span>
            <button
              onClick={skipAuth}
              className="text-muted hover:text-accent text-xs ml-2 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default AuthGate;
