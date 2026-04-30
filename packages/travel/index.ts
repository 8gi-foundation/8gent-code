export type {
	CabinClass,
	FlightLocation,
	FlightOffer,
	FlightProvider,
	FlightSearchRequest,
	FlightSearchResult,
	FlightSort,
	LocationLookupRequest,
	LocationLookupResult,
} from "./types";
export { LetsFGFlightProvider, LetsFGProviderError } from "./letsfg-provider";

export function createDefaultFlightProvider(): LetsFGFlightProvider {
	return new LetsFGFlightProvider({
		apiKey: process.env.LETSFG_API_KEY,
		baseUrl: process.env.LETSFG_BASE_URL,
	});
}

export function formatTravelError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

import { LetsFGFlightProvider } from "./letsfg-provider";
