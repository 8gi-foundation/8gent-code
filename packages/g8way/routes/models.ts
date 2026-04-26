/**
 * @8gent/g8way - GET /v1/models
 *
 * Returns the list of models the proxy is configured to serve, in the
 * OpenAI list-models response shape so SDK clients see a familiar
 * payload.
 */

import type { Hono } from "hono";
import type { G8wayConfig, OpenAIModelList } from "../types";

export function registerModelsRoute(app: Hono, config: G8wayConfig): void {
	app.get("/v1/models", (c) => {
		const created = Math.floor(Date.now() / 1000);
		const body: OpenAIModelList = {
			object: "list",
			data: config.allowedModels.map((id) => ({
				id,
				object: "model",
				created,
				owned_by: "g8way",
			})),
		};
		return c.json(body);
	});
}
