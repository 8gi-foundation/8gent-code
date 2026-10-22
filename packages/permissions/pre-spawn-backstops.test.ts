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
	"{ 8gent chat; }",
	"if true; then 8gent chat; fi",
	"for x in 1; do 8gent chat; done",
	"while true; do 8gent chat; done",
	"! 8gent chat",
	"`8gent chat`",
	"eval 8gent chat",
	"eval '8gent chat'",
	"sudo -u root 8gent chat",
	"env -u X 8gent chat",
	"exec -a foo 8gent chat",
	"doas 8gent chat",
	"setsid 8gent chat",
	"caffeinate 8gent chat",
	"script -q /dev/null 8gent chat",
	"node bin/8gent-run.js chat",
	"bun x 8gent chat",
	"8gent",
	"8gent<in.txt",
	"node bin/8gent.ts",
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

const SPAWNS_3 = [
	"a=EIGHT_PARENT; b=_SESSION; env -u $a$b sh -c 'x=8g;y=ent;$x$y chat'",
	"env --unset=$a$b sh",
	"env -S 'x y' z",
	"env -iu FOO sh",
	"sudo env -i sh",
	"echo hi; env -i sh",
	"~/.bun/bin/8 chat",
	"sudo -u root ~/.bun/bin/8 chat",
	"/usr/local/bin/8 run x",
];

const SPAWNS_2 = [
	"~/.bun/bin/8 chat",
	"/usr/local/bin/8 run x",
	"EIGHT_ALLOW_NESTED=1 x chat",
	"export EIGHT_ALLOW_NESTED=1",
	"env -u EIGHT_PARENT_SESSION foo",
	"unset EIGHT_PARENT_SESSION; x=8gent; $x chat",
	"unset FOO",
	"env -i PATH=$PATH sh -c 'x=8g; y=ent; $x$y chat'",
	"env --ignore-environment sh",
];

const SAFE = [
	"grep -i env README.md",
	"env --version",
	"env -0",
	"env FOO=1 ls",
	"cat notes/8",
	"ls ~/wt/8",
	"echo hi",
	"cat 8/notes.md",
	"8ball",
	"cd ~/8gent-code && git status",
	"node server.js run",
	"sudo ls",
	"env FOO=1 ls",
	"time ls",
	"timeout 5 ls",
	"nice -n 5 ls",
	"which 8gent",
	"command -v 8gent",
	"8gent --version",
	"8gent --help",
];

/** Refused by design: the rule is position-free, so a mention of the binary trips it. */
const REFUSED_BY_DESIGN = [
	"grep '8gent chat' x",
	'grep -r "8gent run" .',
	"echo 8gent chat",
	"echo 8gent",
	"ls 8gent-code",
	"git commit -m '8gent chat fix'",
	"8gent memory recall foo",
	"npx @8gi-foundation/8gent-code --version",
	"which 8gent; 8gent chat",
];

describe("self-spawn backstop", () => {
	test.each(SPAWNS)("refuses %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test.each(SPAWNS_3)("refuses %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test.each(SPAWNS_2)("refuses %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test.each(SAFE)("allows %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(false);
	});

	test.each(REFUSED_BY_DESIGN)("refuses by design: %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test("preSpawnRefusal says you are already 8gent", () => {
		expect(preSpawnRefusal("8 chat hi", process.cwd())).toContain("already 8gent");
		expect(preSpawnRefusal("echo hi", process.cwd())).toBeNull();
	});
});
