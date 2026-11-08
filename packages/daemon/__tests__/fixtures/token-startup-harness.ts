/**
 * Runs the real daemon main() (packages/daemon/index.ts), then reports what a
 * child spawned afterwards can see. Used by bot-token.test.ts as a subprocess so
 * main()'s process.env is the one under test. Prints one RESULT line of JSON.
 */
import { spawnSync } from "node:child_process";
import { main } from "../../index";

// The needle comes in argv, not env, so the harness's own environ holds the token only when a case puts it there.
const FAKE = process.argv[2] as string;
process.argv.splice(2, 1);

await main();

// A child spawned after startup: its own env, then a climb up every ancestor's
// /proc/<pid>/environ (the #97 route). The needle travels in argv ($1), so it
// never lands in an environ block itself.
const script = `
echo "ENV:$(env | grep -c -F -- "$1")"
p=$$
hits=0
while [ "$p" -gt 1 ] 2>/dev/null; do
  if [ -r /proc/$p/environ ] && tr '\\0' '\\n' < /proc/$p/environ | grep -q -F -- "$1"; then
    hits=$((hits+1)); echo "PROC_HIT:$p"
  fi
  p=$(awk '{print $4}' /proc/$p/stat 2>/dev/null) || break
  [ -n "$p" ] || break
done
echo "PROC_HITS:$hits"
`;
// Two spawn shapes. Bun.spawn with no env option is deliberately not one of them: Bun keeps
// serving the exec-time environ there even after `delete process.env.X`, so daemon code must
// pass env explicitly (run_command does, via packages/eight/harness/child-env.ts).
const out = spawnSync("sh", ["-c", script, "sh", FAKE]).stdout.toString(); // node default env
const outExplicit = Bun.spawnSync(["sh", "-c", script, "sh", FAKE], { env: process.env }).stdout.toString();
console.log(
	`RESULT ${JSON.stringify({
		envHasToken: Object.values(process.env).some((v) => v?.includes(FAKE)),
		childEnvHits: Number(/ENV:(\d+)/.exec(out)?.[1] ?? -1),
		procHits: Number(/PROC_HITS:(\d+)/.exec(out)?.[1] ?? -1),
		explicitEnvHits: Number(/ENV:(\d+)/.exec(outExplicit)?.[1] ?? -1),
		platform: process.platform,
	})}`,
);
process.exit(0);
