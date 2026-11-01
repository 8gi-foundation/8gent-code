/**
 * Test preload (bunfig.toml [test].preload): System One is on by default in
 * the product, and off in this test process unless a test turns it on.
 *
 * With EIGHT_SYSTEM_ONE unset, every test that runs a shell command through
 * the agent's tools would probe this machine's judge (the shared Ollama at
 * localhost:11434, a Selene GGUF in the Ollama store) and could load it: the
 * suite would then depend on, and load, whatever the host has installed
 * (#3133). That is a property of the test process, so it lives here. Tests of
 * System One pass their own env (systemOneGate(cmd, {})) or set the variable
 * themselves; an explicit EIGHT_SYSTEM_ONE in the environment is kept.
 */
if (process.env.EIGHT_SYSTEM_ONE === undefined) process.env.EIGHT_SYSTEM_ONE = "0";

/**
 * Agent depth (#3341) is also a property of the test process. A `bun test` an
 * agent starts from its shell carries the agent's EIGHT_AGENT_DEPTH; inherited
 * here, it would make the runner a depth-N agent, shift every depth assertion
 * and, past MAX_AGENT_DEPTH, refuse every Agent the suite builds. Deleted
 * before any test module loads, so packages/orchestration reads depth 0. Tests
 * that need a process depth start a subprocess with the value set.
 */
delete process.env.EIGHT_AGENT_DEPTH;
