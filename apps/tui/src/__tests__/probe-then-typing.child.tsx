/**
 * Child for probe-then-typing.test.ts: the real probe, then real Ink with a
 * key handler, run on Bun stdin pipes made to look like a tty by the
 * hostile-terminal preload. Prints KEY=<json> on stderr for each key Ink gets.
 */
import { Text, render, useInput } from "ink";
import React from "react";
import { probeTerminalBackground } from "../theme/terminal-probe.js";

await probeTerminalBackground();
const App = () => {
	useInput((input) => {
		console.error(`KEY=${JSON.stringify(input)}`);
	});
	return <Text>ready</Text>;
};
render(<App />);
setTimeout(() => process.exit(0), 4000);
