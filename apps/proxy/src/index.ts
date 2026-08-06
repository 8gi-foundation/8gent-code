#!/usr/bin/env bun
/**
 * 8gent-proxy entry point.
 *
 * Parses CLI flags / env, starts the OpenAI-compatible localhost gateway, and
 * prints how to point a client at it. Compiles to a single binary via
 * `bun build --compile` (see `scripts/compile.sh`).
 *
 * Flags:
 *   --port <n>      listen port      (env PROXY_PORT, default 8787)
 *   --host <addr>   bind address     (env PROXY_HOST, default 127.0.0.1)
 *   --version       print version and exit
 *   --help          print usage and exit
 *
 * Binding defaults to loopback: the proxy is local-first and does not expose
 * itself on the network unless you pass `--host 0.0.0.0` deliberately.
 */

import { DEFAULT_HOST, DEFAULT_PORT, startServer } from "./server";

const VERSION = "0.1.0";

function parseArgs(argv: string[]): {
	port: number;
	host: string;
	help: boolean;
	version: boolean;
} {
	let port = Number.parseInt(process.env.PROXY_PORT ?? "", 10);
	if (!Number.isFinite(port)) port = DEFAULT_PORT;
	let host = process.env.PROXY_HOST ?? DEFAULT_HOST;
	let help = false;
	let version = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port" || arg === "-p") {
			const next = Number.parseInt(argv[++i] ?? "", 10);
			if (Number.isFinite(next)) port = next;
		} else if (arg === "--host" || arg === "-H") {
			host = argv[++i] ?? host;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--version" || arg === "-v") {
			version = true;
		}
	}
	return { port, host, help, version };
}

const USAGE = `8gent-proxy ${VERSION} - OpenAI-compatible localhost gateway for the 8gent adaptive router.

Usage: 8gent-proxy [options]

Options:
  -p, --port <n>     Listen port (env PROXY_PORT, default ${DEFAULT_PORT})
  -H, --host <addr>  Bind address (env PROXY_HOST, default ${DEFAULT_HOST})
  -v, --version      Print version and exit
  -h, --help         Show this help

Point any OpenAI-compatible client at http://<host>:<port>/v1
Routing, the PII-egress gate, thinking-level resolution and failover all live
in the 8gent router - this process only translates the OpenAI wire format.`;

function main(): void {
	const { port, host, help, version } = parseArgs(process.argv.slice(2));

	if (help) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	if (version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}

	const server = startServer({ port, host });
	process.stdout.write(
		`8gent-proxy ${VERSION} listening on http://${host}:${server.port}\n` +
			`  OpenAI base URL: http://${host}:${server.port}/v1\n` +
			`  Health:          http://${host}:${server.port}/health\n`,
	);

	const shutdown = () => {
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main();
