import React from "react";
import { ThemeProvider } from "../theme/index.js";
import { ADHDModeContext } from "../components/bionic-text.js";

interface AppProvidersProps {
  adhdMode: boolean;
  adhdRatio?: number;
  children: React.ReactNode;
}

export function AppProviders({ adhdMode, adhdRatio = 0.5, children }: AppProvidersProps) {
  return (
    <ThemeProvider>
      <ADHDModeContext.Provider value={{ enabled: adhdMode, ratio: adhdRatio }}>
        {children}
      </ADHDModeContext.Provider>
    </ThemeProvider>
  );
}
