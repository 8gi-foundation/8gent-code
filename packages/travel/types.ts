export type CabinClass = "M" | "W" | "C" | "F";
export type FlightSort = "price" | "duration";

export interface LocationLookupRequest {
	query: string;
}

export interface FlightLocation {
	iataCode: string;
	name: string;
	type?: "airport" | "city" | string;
	city?: string;
	country?: string;
}

export interface LocationLookupResult {
	provider: "letsfg";
	results: FlightLocation[];
}

export interface FlightSearchRequest {
	origin: string;
	destination: string;
	dateFrom: string;
	dateTo?: string;
	adults?: number;
	cabin?: CabinClass;
	maxStops?: number;
	currency?: string;
	limit?: number;
	sort?: FlightSort;
}

export interface FlightSegment {
	airline?: string;
	flightNo?: string;
	origin?: string;
	destination?: string;
	departure?: string;
	arrival?: string;
	durationSeconds?: number;
	cabin?: string;
}

export interface FlightRoute {
	route?: string;
	totalDurationSeconds?: number;
	stopovers?: number;
	segments: FlightSegment[];
}

export interface FlightOffer {
	providerOfferId: string;
	price?: number;
	currency?: string;
	airlines: string[];
	ownerAirline?: string;
	route?: string;
	durationSeconds?: number;
	stopovers?: number;
	source?: string;
	conditions?: Record<string, unknown>;
	outbound?: FlightRoute;
	inbound?: FlightRoute;
}

export interface FlightSearchResult {
	provider: "letsfg";
	searchId?: string;
	totalResults: number;
	offers: FlightOffer[];
	safety: {
		bookingEnabled: false;
		message: string;
	};
}

export interface FlightProvider {
	resolveLocation(request: LocationLookupRequest): Promise<LocationLookupResult>;
	searchFlights(request: FlightSearchRequest): Promise<FlightSearchResult>;
}
