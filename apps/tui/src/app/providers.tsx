import type React from "react";
import { ADHDModeContext } from "../components/bionic-text.js";
// ThemeProvider is defined in theme/index.ts directly (not a re-export); the
// `export *` for tokens/semantic is what makes the linter flag it as a barrel.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { ThemeProvider } from "../theme/index.js";

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
