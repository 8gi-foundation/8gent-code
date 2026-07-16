/**
 * Fake external coding-agent CLI used by the CliHarness test suite
 * (part of #2797). Behaviour is selected by the first argv element so tests
 * can exercise every mapping heuristic with known, deterministic output.
 *
 * Modes:
 *   echo-args   print each remaining argv element on its own line, exit 0
 *   lines       print two known lines of work output, exit 0
 *   fail        print "boom" to stderr, exit 3
 *   prompt      print an interactive confirmation prompt, then finish, exit 0
 *   stdin-echo  read stdin fully, print it prefixed with "STDIN:", exit 0
 *   hang        print one line, then sleep far longer than any test timeout
 */

export {};

const [mode, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
	switch (mode) {
		case "echo-args": {
			for (const arg of rest) console.log(arg);
			return;
		}
		case "lines": {
			console.log("scanning repository");
			console.log("applying patch");
			return;
		}
		case "fail": {
			console.error("boom");
			process.exit(3);
			return;
		}
		case "prompt": {
			console.log("About to overwrite files. Continue? [y/N]");
			await new Promise((resolve) => setTimeout(resolve, 50));
			console.log("proceeding");
			return;
		}
		case "stdin-echo": {
			let input = "";
			for await (const chunk of process.stdin) {
				input += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			}
			console.log(`STDIN:${input}`);
			return;
		}
		case "hang": {
			console.log("started");
			await new Promise((resolve) => setTimeout(resolve, 60_000));
			return;
		}
		default: {
			console.error(`unknown mode: ${mode}`);
			process.exit(64);
		}
	}
}

await main();
