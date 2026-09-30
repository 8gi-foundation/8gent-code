/**
 * Two agents in one process, each firing hooks (#3147). Run with a throwaway
 * HOME: registering a hook persists it to ~/.8gent/hooks.json.
 *
 *   HOME=<tmp> EIGHT_HOOKS_YAML=<yaml> bun hook-dirs-probe.ts <dirA> <dirB> <shellLog>
 *
 * The shell hook and the YAML hook both append `pwd` to a log, so the log
 * shows the directory each hook actually ran in.
 */
export {};

const [dirA, dirB, shellLog] = process.argv.slice(2);

const { getHookManager, registerShellHook } = await import("../../index");
const { ToolExecutor } = await import("../../../eight/tools");
const { Agent } = await import("../../../eight/agent");

registerShellHook("beforeCommand", "pwd-probe", `pwd >> '${shellLog}'`);

// Text-tool path: each agent's ToolExecutor, the second built after the first.
const execA = new ToolExecutor(dirA);
const execB = new ToolExecutor(dirB);
await execA.execute("run_command", { command: "pwd" });
await execB.execute("run_command", { command: "pwd" });

// Native path: the YAML PreToolUse hook the Agent fires before each tool call,
// with the second Agent built after the first.
new Agent({ model: "probe:1b", runtime: "ollama", workingDirectory: dirA });
new Agent({ model: "probe:1b", runtime: "ollama", workingDirectory: dirB });
await getHookManager().fire("PreToolUse", { tool: "read_file", workingDirectory: dirA });

process.exit(0);
