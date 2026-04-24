// @8gent/hands - placeholder package.
//
// Target: 8gent-hands, an adapted fork of trycua/cua (MIT) for driving the
// macOS desktop from the 8gent Computer app. No driver code has been imported
// yet. This file exists so other packages can take a type import against the
// stable entry point while the fork is planned.
//
// See: docs/prd/8gent-computer/architecture.md (PR #1747) and parent PRD #1746.

export interface HandsDriver {
  /** Human-readable driver identity, e.g. "hands-macos-v0". */
  readonly id: string;
}

export const HANDS_PLACEHOLDER = true as const;
