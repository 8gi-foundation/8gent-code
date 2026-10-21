// Imported first by apps/tui/src/index.tsx. BUN_BE_BUN turns any 8gent binary it
// reaches into a generic Bun runtime, so if it is set when the TUI starts it must
// not survive into the shell tools and sub-sessions the TUI starts (#3894). The
// compiled binary no longer sets it to start the TUI (#4671); the guard stays.
delete process.env.BUN_BE_BUN;
