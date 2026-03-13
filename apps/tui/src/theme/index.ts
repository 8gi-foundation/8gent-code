/**
 * Theme system for the 8gent TUI.
 *
 * Usage:
 *   import { ThemeProvider, useTheme } from './theme/index.js';
 *
 *   // Wrap your app:
 *   <ThemeProvider><App /></ThemeProvider>
 *
 *   // In any component:
 *   const theme = useTheme();
 *   <Text color={theme.text.success}>Done</Text>
 *   <Text dimColor={theme.text.muted === theme.MUTED}>Subtle note</Text>
 */

import React, { createContext, useContext } from 'react';
import { semanticTheme } from './semantic.js';
import type { SemanticTheme } from './semantic.js';

// ---- Re-exports so consumers can do a single import ----
export * from './tokens.js';
export * from './semantic.js';

// ---- Context ----

const ThemeContext = createContext<SemanticTheme>(semanticTheme);

export { ThemeContext };

// ---- Provider ----

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Override the default semantic theme (e.g. for testing). */
  value?: SemanticTheme;
}

export function ThemeProvider({ children, value }: ThemeProviderProps): React.ReactElement {
  return React.createElement(
    ThemeContext.Provider,
    { value: value ?? semanticTheme },
    children,
  );
}

// ---- Hook ----

/**
 * Returns the current semantic theme object.
 * Must be called inside a <ThemeProvider>.
 */
export function useTheme(): SemanticTheme {
  return useContext(ThemeContext);
}
