/** #4715: a run must not start a second 8gent. Every spelling the shell would run as one. */
import { describe, expect, test } from "bun:test";
import { preSpawnRefusal, spawnsSelf } from "./pre-spawn-backstops";

const SPAWNS = [
	"8gent chat hello",
	"8gent run 'do it'",
	"8gent mcp-server --tools=safe < in.jsonl",
	"bun bin/8gent.ts chat hi",
	"cd /tmp && 8gent chat hi",
	"FOO=1 8gent run x",
	"echo hi; 8gent mcp-server",
	"./node_modules/.bin/8gent chat x",
	"node dist/cli.js chat hi",
	"node /x/cli.js run do-it",
	"npx @8gi-foundation/8gent-code run hi",
	"npx -y @8gi-foundation/8gent-code mcp-server",
	"bun dist/cli.js mcp-server",
	"8gent-run x",
	"8gent-run",
	"8gent --model x chat",
	"8gent --model x --yes run hi",
	"bash -c '8gent chat'",
	'sh -c "8gent run hi"',
	"zsh -c '8gent chat'",
	"env 8gent chat",
	"env -i FOO=1 8gent chat",
	"nohup 8gent chat",
	"exec 8gent run x",
	"time 8gent chat",
	"command 8gent chat",
	"sudo 8gent chat",
	"echo x | xargs 8gent run",
	"$(which 8gent) chat",
	"nohup env 8gent mcp-server",
	"8 chat",
	"8 run x",
	"'8gent' chat",
	'"8gent" chat',
	"8\\gent chat",
	"8ge''nt chat",
	"timeout 5 8gent chat",
	"timeout -s KILL 5 8gent chat",
	"nice 8gent chat",
	"nice -n 5 8gent chat",
	"stdbuf -o0 8gent chat",
	"stdbuf -oL -eL 8gent run x",
];

const SAFE = [
	"echo hi",
	"grep '8gent chat' x",
	'grep -r "8gent run" .',
	"echo 8gent chat",
	"8gent --version",
	"8gent memory recall foo",
	"cat 8/notes.md",
	"8ball",
	"git commit -m '8gent chat fix'",
	"ls 8gent-code",
	"node server.js run",
	"npx @8gi-foundation/8gent-code --version",
	"sudo ls",
	"env FOO=1 ls",
	"time ls",
	"timeout 5 ls",
	"nice -n 5 ls",
];

describe("self-spawn backstop", () => {
	test.each(SPAWNS)("refuses %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test.each(SAFE)("allows %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(false);
	});

	test("preSpawnRefusal says you are already 8gent", () => {
		expect(preSpawnRefusal("8 chat hi", process.cwd())).toContain("already 8gent");
		expect(preSpawnRefusal("echo hi", process.cwd())).toBeNull();
	});
});
