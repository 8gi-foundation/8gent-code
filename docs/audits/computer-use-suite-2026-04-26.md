# Computer-use smoke suite 2026-04-26

**Result:** 8/8 pass.

**Channel resolver:** computer -> apfel/apple-foundationmodel

**Mode:** headless, mock hands + mock LLM. Production path unchanged.

| ID | Title | Pass | Steps | Tools called |
|----|-------|------|-------|--------------|
| P3-01 | Open app | yes | 4 | desktop_press, desktop_type, desktop_press, goal_complete |
| P3-02 | Find file | yes | 2 | desktop_accessibility_tree, goal_complete |
| P3-03 | Click button | yes | 3 | desktop_accessibility_tree, desktop_click, goal_complete |
| P3-04 | Screenshot region | yes | 2 | desktop_screenshot, goal_complete |
| P3-05 | Count items | yes | 2 | desktop_accessibility_tree, goal_complete |
| P3-06 | Type into field | yes | 3 | desktop_accessibility_tree, desktop_type, goal_complete |
| P3-07 | Switch app | yes | 2 | desktop_press, goal_complete |
| P3-08 | Dismiss dialog | yes | 2 | desktop_press, goal_complete |

## Failures

None.

## Notes

- NemoClaw policy gate is preserved in the production path
  (`packages/daemon/tools/hands.ts`). The smoke suite swaps in a
  mock adapter via `CuaLoopConfig.handsAdapter` so CI does not
  need a real desktop, but the gate is exercised by
  `packages/permissions/policy-engine.test.ts`.