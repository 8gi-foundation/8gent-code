import type {
	FlightOffer,
	FlightProvider,
	FlightRoute,
	FlightSearchRequest,
	FlightSearchResult,
	FlightSegment,
	LocationLookupRequest,
	LocationLookupResult,
} from "./types";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface LetsFGFlightProviderOptions {
	apiKey?: string;
	baseUrl?: string;
	fetcher?: Fetcher;
}

interface LetsFGLocation {
	iata_code?: string;
	name?: string;
	type?: string;
	city?: string;
	country?: string;
}

interface LetsFGRoute {
	route_str?: string;
	total_duration_seconds?: number;
	stopovers?: number;
	segments?: LetsFGSegment[];
}

interface LetsFGSegment {
	airline?: string;
	flight_no?: string;
	origin?: string;
	destination?: string;
	departure?: string;
	arrival?: string;
	duration_seconds?: number;
	cabin?: string;
}

interface LetsFGOffer {
	id?: string;
	price?: number;
	currency?: string;
	airlines?: string[];
	owner_airline?: string;
	route?: string;
	duration_seconds?: number;
	stopovers?: number;
	source?: string;
	conditions?: Record<string, unknown>;
	outbound?: LetsFGRoute;
	inbound?: LetsFGRoute;
}

interface LetsFGSearchResponse {
	search_id?: string;
	total_results?: number;
	offers?: LetsFGOffer[];
}

export class LetsFGProviderError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "LetsFGProviderError";
	}
}

export class LetsFGFlightProvider implements FlightProvider {
	private readonly apiKey?: string;
	private readonly baseUrl: string;
	private readonly fetcher: Fetcher;

	constructor(options: LetsFGFlightProviderOptions = {}) {
		this.apiKey = options.apiKey?.trim() || undefined;
		this.baseUrl = (options.baseUrl || "https://api.letsfg.co").replace(/\/+$/, "");
		this.fetcher = options.fetcher || fetch;
	}

	async resolveLocation(request: LocationLookupRequest): Promise<LocationLookupResult> {
		this.requireApiKey();
		const query = request.query.trim();
		if (!query) {
			throw new LetsFGProviderError("Location query is required.");
		}

		const locations = await this.resolveLocations(query);

		return {
			provider: "letsfg",
			results: locations.map((location) => ({
				iataCode: String(location.iata_code || "").toUpperCase(),
				name: location.name || "",
				type: location.type,
				city: location.city,
				country: location.country,
			})),
		};
	}

	async searchFlights(request: FlightSearchRequest): Promise<FlightSearchResult> {
		this.requireApiKey();
		const body = compact({
			origin: iata(request.origin),
			destination: iata(request.destination),
			date_from: request.dateFrom,
			date_to: request.dateTo,
			adults: request.adults,
			cabin: request.cabin,
			max_stops: request.maxStops,
			currency: request.currency?.toUpperCase(),
			limit: request.limit,
			sort: request.sort,
		});

		const response = await this.request<LetsFGSearchResponse>("/api/v1/flights/search", {
			method: "POST",
			body: JSON.stringify(body),
		});

		return {
			provider: "letsfg",
			searchId: response.search_id,
			totalResults: response.total_results ?? response.offers?.length ?? 0,
			offers: (response.offers || []).map(normalizeOffer).filter((offer) => offer.providerOfferId),
			safety: {
				bookingEnabled: false,
				message:
					"Phase 1 is search-only. 8gent does not unlock, book, collect payment, or store passenger profiles through this provider.",
			},
		};
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const request = new Request(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				accept: "application/json",
				...(init.body ? { "content-type": "application/json" } : {}),
				"x-api-key": this.apiKey || "",
				...init.headers,
			},
		});
		const response = await this.fetcher(request);

		if (!response.ok) {
			throw new LetsFGProviderError(
				`LetsFG API request failed (${response.status}): ${await safeText(response)}`,
				response.status,
			);
		}

		return (await response.json()) as T;
	}

	private requireApiKey(): void {
		if (!this.apiKey) {
			throw new LetsFGProviderError(
				"LETSFG_API_KEY is required for the LetsFG production API. Store it in the runtime environment, not in chat or source control.",
			);
		}
	}

	private async resolveLocations(query: string): Promise<LetsFGLocation[]> {
		try {
			return await this.request<LetsFGLocation[]>(
				`/api/v1/flights/resolve-location?query=${encodeURIComponent(query)}`,
			);
		} catch (error) {
			if (error instanceof LetsFGProviderError && (error.status === 404 || error.status === 405)) {
				return this.request<LetsFGLocation[]>(
					`/api/v1/flights/locations/${encodeURIComponent(query)}`,
				);
			}
			throw error;
		}
	}
}

function normalizeOffer(offer: LetsFGOffer): FlightOffer {
	return {
		providerOfferId: offer.id || "",
		price: offer.price,
		currency: offer.currency,
		airlines: offer.airlines || [],
		ownerAirline: offer.owner_airline,
		route: offer.route,
		durationSeconds: offer.duration_seconds,
		stopovers: offer.stopovers,
		source: offer.source,
		conditions: offer.conditions,
		outbound: normalizeRoute(offer.outbound),
		inbound: normalizeRoute(offer.inbound),
	};
}

function normalizeRoute(route?: LetsFGRoute): FlightRoute | undefined {
	if (!route) return undefined;
	return {
		route: route.route_str,
		totalDurationSeconds: route.total_duration_seconds,
		stopovers: route.stopovers,
		segments: (route.segments || []).map(normalizeSegment),
	};
}

function normalizeSegment(segment: LetsFGSegment): FlightSegment {
	return {
		airline: segment.airline,
		flightNo: segment.flight_no,
		origin: segment.origin,
		destination: segment.destination,
		departure: segment.departure,
		arrival: segment.arrival,
		durationSeconds: segment.duration_seconds,
		cabin: segment.cabin,
	};
}

function iata(value: string): string {
	const code = value.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(code)) {
		throw new LetsFGProviderError(`Expected a 3-letter IATA code, received "${value}".`);
	}
	return code;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as Partial<T>;
}

async function safeText(response: Response): Promise<string> {
	const text = await response.text();
	return text.slice(0, 500) || response.statusText;
}
