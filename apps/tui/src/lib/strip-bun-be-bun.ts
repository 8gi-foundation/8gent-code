// Imported first by apps/tui/src/index.tsx. The compiled binary launches this
// bundle as `<binary> run ...` with BUN_BE_BUN=1 (see embedded-bundle.ts). That
// variable turns any 8gent binary it reaches into a generic Bun runtime, so it
// must not survive into the shell tools and sub-sessions the TUI starts (#3894).
delete process.env.BUN_BE_BUN;
