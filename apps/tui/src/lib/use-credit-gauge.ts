/**
 * Credit gauge text for the active provider (#4539). The render path reads the
 * cached file only; the single network refresh runs in the background, rate
 * limited inside refreshCredits, and only for a hosted provider.
 */
import { useEffect, useState } from "react";
import {
	CREDIT_REFRESH_MS,
	creditGaugeText,
	refreshCredits,
} from "../../../../packages/providers/credits.js";

export function useCreditGauge(provider: string): string {
	const [text, setText] = useState(() => creditGaugeText(provider));
	useEffect(() => {
		setText(creditGaugeText(provider));
		if (creditGaugeText(provider) === "local") return;
		const tick = () => {
			void refreshCredits().then(() => setText(creditGaugeText(provider)));
		};
		tick();
		const id = setInterval(tick, CREDIT_REFRESH_MS);
		return () => clearInterval(id);
	}, [provider]);
	return text;
}
