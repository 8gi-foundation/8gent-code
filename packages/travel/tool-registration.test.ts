import { describe, expect, it } from "bun:test";
import { agentTools } from "../ai/tools.js";
import { TOOL_CATEGORIES } from "../eight/tool-registry.js";

describe("travel tool registration", () => {
	it("exposes search-only travel tools", () => {
		expect(agentTools.travel_resolve_location).toBeDefined();
		expect(agentTools.travel_search_flights).toBeDefined();
		expect(TOOL_CATEGORIES.travel).toEqual(["travel_resolve_location", "travel_search_flights"]);
	});

	it("does not expose booking, unlock, payment, or passenger profile tools in phase 1", () => {
		expect(agentTools).not.toHaveProperty("travel_unlock_offer");
		expect(agentTools).not.toHaveProperty("travel_book_flight");
		expect(agentTools).not.toHaveProperty("travel_setup_payment");
		expect(agentTools).not.toHaveProperty("travel_save_passenger_profile");
	});
});
