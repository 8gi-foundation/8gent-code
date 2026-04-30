/**
 * Inference clients for @8gent/eight-bdh.
 *
 * LocalClient  - subprocess or HTTP shim into the local Python inference server.
 * VesselClient - WebSocket / HTTP into eight-vessel.fly.dev.
 *
 * Phase 0: shapes only. Bodies throw "not implemented yet".
 */

import type { OrchestratorInput, Decision, AuditTrace } from "./types";

export interface InferenceClient {
	infer(
		input: OrchestratorInput,
	): Promise<{ decision: Decision; trace: AuditTrace }>;
}

export interface LocalClientOptions {
	weightsPath?: string;
	pythonBin?: string;
	port?: number;
}

export class LocalClient implements InferenceClient {
	private readonly opts: LocalClientOptions;

	constructor(opts: LocalClientOptions = {}) {
		this.opts = opts;
	}

	async infer(
		_input: OrchestratorInput,
	): Promise<{ decision: Decision; trace: AuditTrace }> {
		// TODO(james): spawn `python -m eight_bdh.serve` (or HTTP to a running daemon)
		// once Phase 0 weights are saved to checkpoints/ and a serve script exists.
		throw new Error(
			"LocalClient.infer not implemented yet - Phase 0. Need: trained checkpoint + Python serve binding.",
		);
	}
}

export interface VesselClientOptions {
	url?: string;
	authToken?: string;
}

export class VesselClient implements InferenceClient {
	private readonly opts: VesselClientOptions;

	constructor(opts: VesselClientOptions = {}) {
		this.opts = {
			url: opts.url ?? "wss://eight-vessel.fly.dev",
			...opts,
		};
	}

	async infer(
		_input: OrchestratorInput,
	): Promise<{ decision: Decision; trace: AuditTrace }> {
		// TODO(james): wire to Daemon Protocol v1.0 once vessel-side BDH inference path lands.
		// Spec §3.3 lists this as a day-one deliverable; Phase 0 ships the local path first.
		throw new Error(
			"VesselClient.infer not implemented yet - Phase 0. Vessel inference path is a Phase 1+ deliverable.",
		);
	}
}
