import { describe, expect, it } from "bun:test";
import { LetsFGFlightProvider } from "./letsfg-provider.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

describe("LetsFGFlightProvider", () => {
	it("resolves locations through the LetsFG API", async () => {
		const calls: Request[] = [];
		const provider = new LetsFGFlightProvider({
			apiKey: "trav_test",
			baseUrl: "https://api.test",
			fetcher: async (input) => {
				const request = input instanceof Request ? input : new Request(input);
				calls.push(request);
				return jsonResponse([
					{
						iata_code: "LON",
						name: "London",
						type: "city",
						city: "London",
						country: "United Kingdom",
					},
				]);
			},
		});

		const result = await provider.resolveLocation({ query: "London" });

		expect(result).toEqual({
			provider: "letsfg",
			results: [
				{
					iataCode: "LON",
					name: "London",
					type: "city",
					city: "London",
					country: "United Kingdom",
				},
			],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.test/api/v1/flights/resolve-location?query=London");
		expect(calls[0].headers.get("x-api-key")).toBe("trav_test");
	});

	it("falls back to the live OpenAPI location path when resolve-location is unavailable", async () => {
		const calls: string[] = [];
		const provider = new LetsFGFlightProvider({
			apiKey: "trav_test",
			baseUrl: "https://api.test",
			fetcher: async (input) => {
				const request = input instanceof Request ? input : new Request(input);
				calls.push(request.url);
				if (request.url.includes("resolve-location")) {
					return jsonResponse({ error: "not found" }, { status: 404 });
				}
				return jsonResponse([{ iata_code: "LHR", name: "Heathrow", type: "airport" }]);
			},
		});

		const result = await provider.resolveLocation({ query: "London" });

		expect(calls).toEqual([
			"https://api.test/api/v1/flights/resolve-location?query=London",
			"https://api.test/api/v1/flights/locations/London",
		]);
		expect(result.results[0]).toMatchObject({ iataCode: "LHR", name: "Heathrow" });
	});

	it("searches flights and returns normalized offers without booking passenger ids", async () => {
		let requestBody: unknown;
		const provider = new LetsFGFlightProvider({
			apiKey: "trav_test",
			baseUrl: "https://api.test",
			fetcher: async (input) => {
				const request = input instanceof Request ? input : new Request(input);
				requestBody = await request.json();
				return jsonResponse({
					search_id: "srch_123",
					passenger_ids: ["pas_0"],
					total_results: 1,
					offers: [
						{
							id: "off_123",
							price: 189.5,
							currency: "EUR",
							airlines: ["Ryanair"],
							owner_airline: "Ryanair",
							route: "STN -> BCN",
							duration_seconds: 7200,
							stopovers: 0,
							source: "ryanair",
							conditions: {
								refund_before_departure: "not_allowed",
								change_before_departure: "allowed_with_fee",
							},
							outbound: {
								route_str: "STN -> BCN",
								total_duration_seconds: 7200,
								stopovers: 0,
								segments: [
									{
										airline: "Ryanair",
										flight_no: "FR123",
										origin: "STN",
										destination: "BCN",
										departure: "2026-06-15T07:00:00Z",
										arrival: "2026-06-15T09:00:00Z",
										duration_seconds: 7200,
										cabin: "M",
									},
								],
							},
						},
					],
				});
			},
		});

		const result = await provider.searchFlights({
			origin: "lon",
			destination: "bcn",
			dateFrom: "2026-06-15",
			adults: 1,
			cabin: "M",
			limit: 5,
		});

		expect(requestBody).toEqual({
			origin: "LON",
			destination: "BCN",
			date_from: "2026-06-15",
			adults: 1,
			cabin: "M",
			limit: 5,
		});
		expect(result.searchId).toBe("srch_123");
		expect(result.totalResults).toBe(1);
		expect(result.offers[0]).toMatchObject({
			providerOfferId: "off_123",
			price: 189.5,
			currency: "EUR",
			airlines: ["Ryanair"],
			route: "STN -> BCN",
			stopovers: 0,
			source: "ryanair",
		});
		expect(JSON.stringify(result)).not.toContain("pas_0");
	});

	it("returns an actionable configuration error when no API key is configured", async () => {
		const provider = new LetsFGFlightProvider({
			baseUrl: "https://api.test",
			fetcher: async () => {
				throw new Error("fetch should not run without an API key");
			},
		});

		await expect(
			provider.searchFlights({ origin: "LHR", destination: "JFK", dateFrom: "2026-06-15" }),
		).rejects.toThrow("LETSFG_API_KEY");
	});
});
