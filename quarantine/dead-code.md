# Dead Code Quarantine Report

Generated: 2026-03-25T01:54:07.051Z

## Summary

| Metric | Count |
|--------|-------|
| Files scanned | 590 |
| Total exports | 2492 |
| Unused exports | 1761 |
| Usage rate | 29.3% |

## Methodology

Scanned all .ts/.tsx/.js/.jsx files in the monorepo. For each exported symbol,
checked whether any other file imports it by name. Exports only referenced within
their own file (or not at all) are flagged as candidates for removal.

False positives are expected for:
- Next.js convention exports (metadata, GET, POST, dynamic, runtime)
- CLI entrypoints and bin scripts
- Exports consumed by external packages or dynamic imports
- Type exports used only in declaration files

## Unused Exports by Area

### apps/tui (223)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `stripAnsi` | apps/tui/src/lib/text.ts | 9 |
| function | `visibleLength` | apps/tui/src/lib/text.ts | 14 |
| const | `ellipsis` | apps/tui/src/lib/text.ts | 27 |
| function | `padRight` | apps/tui/src/lib/text.ts | 30 |
| function | `padCenter` | apps/tui/src/lib/text.ts | 37 |
| function | `repeatChar` | apps/tui/src/lib/text.ts | 47 |
| function | `wrapText` | apps/tui/src/lib/text.ts | 53 |
| other | `SessionEvent` | apps/tui/src/lib/session-logger.ts | 19 |
| other | `SessionLog` | apps/tui/src/lib/session-logger.ts | 26 |
| function | `getSessionLog` | apps/tui/src/lib/session-logger.ts | 357 |
| function | `getSessionPath` | apps/tui/src/lib/session-logger.ts | 381 |
| function | `getSessionSummary` | apps/tui/src/lib/session-logger.ts | 388 |
| function | `formatRelativeTime` | apps/tui/src/lib/format.ts | 76 |
| function | `clamp` | apps/tui/src/lib/layout.ts | 7 |
| function | `columnWidth` | apps/tui/src/lib/layout.ts | 18 |
| function | `fitColumns` | apps/tui/src/lib/layout.ts | 34 |
| function | `distributeWidths` | apps/tui/src/lib/layout.ts | 62 |
| other | `ADHDAudioConfig` | apps/tui/src/lib/adhd-audio.ts | 35 |
| class | `ADHDAudio` | apps/tui/src/lib/adhd-audio.ts | 122 |
| other | `KanbanCard` | apps/tui/src/hooks/useAutoKanban.ts | 19 |
| other | `AutoKanbanColumns` | apps/tui/src/hooks/useAutoKanban.ts | 35 |
| other | `AutoKanbanStats` | apps/tui/src/hooks/useAutoKanban.ts | 42 |
| other | `UseAutoKanbanReturn` | apps/tui/src/hooks/useAutoKanban.ts | 49 |
| type | `FocusZone` | apps/tui/src/hooks/useProcessPanel.ts | 6 |
| other | `ProcessPanelState` | apps/tui/src/hooks/useProcessPanel.ts | 8 |
| other | `GhostSuggestion` | apps/tui/src/hooks/use-ghost-suggestion.ts | 17 |
| type | `SuggestionSource` | apps/tui/src/hooks/use-ghost-suggestion.ts | 24 |
| other | `GhostSuggestionOptions` | apps/tui/src/hooks/use-ghost-suggestion.ts | 30 |
| function | `useGhostSuggestion` | apps/tui/src/hooks/use-ghost-suggestion.ts | 43 |
| function | `formatGhostText` | apps/tui/src/hooks/use-ghost-suggestion.ts | 357 |
| function | `getSuggestionSourceLabel` | apps/tui/src/hooks/use-ghost-suggestion.ts | 361 |
| other | `TabIcon` | apps/tui/src/hooks/useWorkspaceTabs.ts | 45 |
| other | `UseVoiceChatOptions` | apps/tui/src/hooks/useVoiceChat.ts | 12 |
| other | `UseVoiceChatReturn` | apps/tui/src/hooks/useVoiceChat.ts | 23 |
| other | `ChatTabState` | apps/tui/src/hooks/useChatTabState.ts | 29 |
| function | `useChatTabState` | apps/tui/src/hooks/useChatTabState.ts | 134 |
| type | `MainPane` | apps/tui/src/hooks/useLayout.ts | 18 |
| type | `SidebarPane` | apps/tui/src/hooks/useLayout.ts | 30 |
| type | `OverlayPane` | apps/tui/src/hooks/useLayout.ts | 33 |
| type | `FocusTarget` | apps/tui/src/hooks/useLayout.ts | 38 |
| other | `LayoutState` | apps/tui/src/hooks/useLayout.ts | 40 |
| function | `useLayout` | apps/tui/src/hooks/useLayout.ts | 76 |
| other | `AgentOrchestrationState` | apps/tui/src/hooks/useAgentOrchestration.ts | 30 |
| other | `AgentOrchestrationActions` | apps/tui/src/hooks/useAgentOrchestration.ts | 40 |
| other | `HotkeyBindings` | apps/tui/src/hooks/useHotkeys.ts | 3 |
| function | `useHotkeys` | apps/tui/src/hooks/useHotkeys.ts | 23 |
| other | `AsyncTaskResult` | apps/tui/src/hooks/useAsyncTask.ts | 3 |
| function | `useAsyncTask` | apps/tui/src/hooks/useAsyncTask.ts | 11 |
| other | `UseVoiceInputOptions` | apps/tui/src/hooks/useVoiceInput.ts | 19 |
| other | `UseVoiceInputReturn` | apps/tui/src/hooks/useVoiceInput.ts | 32 |
| other | `Viewport` | apps/tui/src/hooks/useViewport.ts | 4 |
| other | `SelectionOptions` | apps/tui/src/hooks/useSelection.ts | 3 |
| other | `SelectionResult` | apps/tui/src/hooks/useSelection.ts | 7 |
| other | `DJState` | apps/tui/src/hooks/useDJ.ts | 19 |
| function | `useDJ` | apps/tui/src/hooks/useDJ.ts | 45 |
| type | `Color` | apps/tui/src/theme/tokens.ts | 19 |
| type | `Space` | apps/tui/src/theme/tokens.ts | 28 |
| type | `Border` | apps/tui/src/theme/tokens.ts | 39 |
| type | `Size` | apps/tui/src/theme/tokens.ts | 50 |
| const | `tokens` | apps/tui/src/theme/tokens.ts | 52 |
| other | `ThemeContext` | apps/tui/src/theme/index.ts | 28 |
| other | `ThemeProviderProps` | apps/tui/src/theme/index.ts | 32 |
| function | `useTheme` | apps/tui/src/theme/index.ts | 52 |
| const | `MUTED` | apps/tui/src/theme/semantic.ts | 18 |
| const | `text` | apps/tui/src/theme/semantic.ts | 20 |
| type | `TextRole` | apps/tui/src/theme/semantic.ts | 33 |
| const | `borderSemantic` | apps/tui/src/theme/semantic.ts | 35 |
| const | `borderColor` | apps/tui/src/theme/semantic.ts | 43 |
| type | `BorderRole` | apps/tui/src/theme/semantic.ts | 51 |
| const | `status` | apps/tui/src/theme/semantic.ts | 53 |
| type | `StatusName` | apps/tui/src/theme/semantic.ts | 61 |
| const | `spacing` | apps/tui/src/theme/semantic.ts | 63 |
| type | `SpacingRole` | apps/tui/src/theme/semantic.ts | 74 |
| const | `layout` | apps/tui/src/theme/semantic.ts | 76 |
| other | `AnimatedStatusVerbProps` | apps/tui/src/components/status-verb.tsx | 93 |
| other | `StatusLineProps` | apps/tui/src/components/status-verb.tsx | 108 |
| function | `StatusLine` | apps/tui/src/components/status-verb.tsx | 208 |
| function | `useStatusVerb` | apps/tui/src/components/status-verb.tsx | 267 |
| function | `InlineStatus` | apps/tui/src/components/status-verb.tsx | 308 |
| function | `BigLogo` | apps/tui/src/components/pulse-logo.tsx | 111 |
| function | `SpinningRing` | apps/tui/src/components/pulse-logo.tsx | 147 |
| function | `GradientBorder` | apps/tui/src/components/rainbow-border.tsx | 83 |
| function | `PulsingBorder` | apps/tui/src/components/rainbow-border.tsx | 128 |
| function | `DecoratedBox` | apps/tui/src/components/rainbow-border.tsx | 161 |
| function | `MusicPlayer` | apps/tui/src/components/MusicPlayer.tsx | 110 |
| function | `CompactMessageItem` | apps/tui/src/components/message-list.tsx | 307 |
| function | `MatrixRain` | apps/tui/src/components/advanced-animations.tsx | 41 |
| function | `FireEffect` | apps/tui/src/components/advanced-animations.tsx | 140 |
| function | `DNAHelix` | apps/tui/src/components/advanced-animations.tsx | 208 |
| function | `Starfield` | apps/tui/src/components/advanced-animations.tsx | 271 |
| function | `BouncingDots` | apps/tui/src/components/advanced-animations.tsx | 371 |
| function | `GlitchText` | apps/tui/src/components/advanced-animations.tsx | 471 |
| function | `Confetti` | apps/tui/src/components/advanced-animations.tsx | 526 |
| function | `Waveform` | apps/tui/src/components/advanced-animations.tsx | 609 |
| function | `RubiksCube` | apps/tui/src/components/advanced-animations.tsx | 727 |
| function | `GradientWave` | apps/tui/src/components/advanced-animations.tsx | 807 |
| function | `LoadingAnimation` | apps/tui/src/components/advanced-animations.tsx | 841 |
| other | `DesignOption` | apps/tui/src/components/design-selector.tsx | 23 |
| other | `DesignSelectorProps` | apps/tui/src/components/design-selector.tsx | 36 |
| other | `DesignSuggestionPanelProps` | apps/tui/src/components/design-selector.tsx | 53 |
| function | `DesignSelector` | apps/tui/src/components/design-selector.tsx | 67 |
| other | `DesignBadgeProps` | apps/tui/src/components/design-selector.tsx | 352 |
| function | `DesignBadge` | apps/tui/src/components/design-selector.tsx | 357 |
| other | `InlineDesignPromptProps` | apps/tui/src/components/design-selector.tsx | 375 |
| function | `InlineDesignPrompt` | apps/tui/src/components/design-selector.tsx | 380 |
| other | `SelectOption` | apps/tui/src/components/select-input.tsx | 26 |
| other | `SelectInputProps` | apps/tui/src/components/select-input.tsx | 34 |
| other | `ConfirmDialogProps` | apps/tui/src/components/select-input.tsx | 257 |
| function | `ConfirmDialog` | apps/tui/src/components/select-input.tsx | 266 |
| other | `QuickAction` | apps/tui/src/components/select-input.tsx | 339 |
| other | `QuickMenuProps` | apps/tui/src/components/select-input.tsx | 346 |
| function | `QuickMenu` | apps/tui/src/components/select-input.tsx | 353 |
| other | `ModelSelectorProps` | apps/tui/src/components/select-input.tsx | 416 |
| function | `ModelSelector` | apps/tui/src/components/select-input.tsx | 424 |
| other | `ProviderOption` | apps/tui/src/components/select-input.tsx | 456 |
| other | `ProviderSelectorProps` | apps/tui/src/components/select-input.tsx | 463 |
| function | `ProviderSelector` | apps/tui/src/components/select-input.tsx | 470 |
| other | `GhostInputProps` | apps/tui/src/components/ghost-suggestion.tsx | 30 |
| function | `GhostInput` | apps/tui/src/components/ghost-suggestion.tsx | 48 |
| other | `GhostTextProps` | apps/tui/src/components/ghost-suggestion.tsx | 135 |
| function | `GhostText` | apps/tui/src/components/ghost-suggestion.tsx | 140 |
| other | `GhostCommandInputProps` | apps/tui/src/components/ghost-suggestion.tsx | 166 |
| function | `GhostCommandInput` | apps/tui/src/components/ghost-suggestion.tsx | 175 |
| other | `SuggestionPreviewProps` | apps/tui/src/components/ghost-suggestion.tsx | 277 |
| function | `SuggestionPreview` | apps/tui/src/components/ghost-suggestion.tsx | 282 |
| function | `SourceIcon` | apps/tui/src/components/ghost-suggestion.tsx | 316 |
| type | `StepCategory` | apps/tui/src/components/plan-kanban.tsx | 17 |
| other | `ProactiveStep` | apps/tui/src/components/plan-kanban.tsx | 27 |
| other | `KanbanBoard` | apps/tui/src/components/plan-kanban.tsx | 39 |
| other | `PreGeneratedStep` | apps/tui/src/components/plan-kanban.tsx | 46 |
| other | `Avenue` | apps/tui/src/components/plan-kanban.tsx | 55 |
| other | `PlanKanbanProps` | apps/tui/src/components/plan-kanban.tsx | 77 |
| other | `AvenueDisplayProps` | apps/tui/src/components/plan-kanban.tsx | 87 |
| other | `PredictedStepsProps` | apps/tui/src/components/plan-kanban.tsx | 94 |
| other | `AutoKanbanCard` | apps/tui/src/components/plan-kanban.tsx | 133 |
| other | `AutoKanbanColumns` | apps/tui/src/components/plan-kanban.tsx | 149 |
| other | `AutoKanbanStats` | apps/tui/src/components/plan-kanban.tsx | 156 |
| other | `AutoPlanKanbanProps` | apps/tui/src/components/plan-kanban.tsx | 163 |
| function | `AvenueDisplay` | apps/tui/src/components/plan-kanban.tsx | 429 |
| function | `PredictedSteps` | apps/tui/src/components/plan-kanban.tsx | 541 |
| function | `AutoPlanKanban` | apps/tui/src/components/plan-kanban.tsx | 614 |
| other | `AutoMiniKanbanProps` | apps/tui/src/components/plan-kanban.tsx | 799 |
| function | `AutoMiniKanban` | apps/tui/src/components/plan-kanban.tsx | 805 |
| other | `MiniKanbanProps` | apps/tui/src/components/plan-kanban.tsx | 856 |
| function | `MiniKanban` | apps/tui/src/components/plan-kanban.tsx | 861 |
| function | `MinimalCommandInput` | apps/tui/src/components/command-input.tsx | 586 |
| function | `MultiLineInput` | apps/tui/src/components/command-input.tsx | 633 |
| function | `CommandPalette` | apps/tui/src/components/command-input.tsx | 662 |
| other | `GhostCommandInputProps` | apps/tui/src/components/command-input.tsx | 730 |
| function | `GhostCommandInput` | apps/tui/src/components/command-input.tsx | 740 |
| function | `getSlashCommands` | apps/tui/src/components/command-input.tsx | 766 |
| function | `isSlashCommand` | apps/tui/src/components/command-input.tsx | 770 |
| function | `parseSlashCommand` | apps/tui/src/components/command-input.tsx | 778 |
| function | `BionicParagraph` | apps/tui/src/components/bionic-text.tsx | 148 |
| function | `parseBionicText` | apps/tui/src/components/bionic-text.tsx | 183 |
| function | `SmartText` | apps/tui/src/components/bionic-text.tsx | 234 |
| const | `ADHD_MODE_SUGGESTION` | apps/tui/src/components/bionic-text.tsx | 252 |
| const | `ADHD_MODE_ENABLED_MSG` | apps/tui/src/components/bionic-text.tsx | 257 |
| const | `ADHD_MODE_DISABLED_MSG` | apps/tui/src/components/bionic-text.tsx | 268 |
| function | `FadeOut` | apps/tui/src/components/fade-transition.tsx | 65 |
| function | `SlideIn` | apps/tui/src/components/fade-transition.tsx | 96 |
| function | `CascadeFade` | apps/tui/src/components/fade-transition.tsx | 192 |
| function | `ConfidenceMeter` | apps/tui/src/components/evidence-panel.tsx | 366 |
| function | `StepPanel` | apps/tui/src/components/evidence-panel.tsx | 393 |
| function | `ValidationReportPanel` | apps/tui/src/components/evidence-panel.tsx | 478 |
| other | `EnhancedStatusBarProps` | apps/tui/src/components/status-bar.tsx | 31 |
| function | `CompactStatusBar` | apps/tui/src/components/status-bar.tsx | 585 |
| function | `CompactHeader` | apps/tui/src/components/header.tsx | 139 |
| function | `AnimatedProgressBar` | apps/tui/src/components/progress-bar.tsx | 37 |
| other | `CompactHeader` | apps/tui/src/components/index.ts | 70 |
| function | `useSound` | apps/tui/src/components/sound-effects.tsx | 52 |
| function | `useErrorSound` | apps/tui/src/components/sound-effects.tsx | 74 |
| function | `SoundEffect` | apps/tui/src/components/sound-effects.tsx | 141 |
| function | `playTypingSound` | apps/tui/src/components/sound-effects.tsx | 155 |
| function | `CompletionReport` | apps/tui/src/components/completion-report.tsx | 92 |
| function | `SimpleCompletionReport` | apps/tui/src/components/completion-report.tsx | 445 |
| function | `StreamingText` | apps/tui/src/components/typing-text.tsx | 73 |
| function | `CodeTyping` | apps/tui/src/components/typing-text.tsx | 146 |
| type | `AnimationType` | apps/tui/src/components/animation-showcase.tsx | 27 |
| function | `AnimationShowcase` | apps/tui/src/components/animation-showcase.tsx | 116 |
| function | `MiniAnimation` | apps/tui/src/components/animation-showcase.tsx | 221 |
| function | `AnimationList` | apps/tui/src/components/animation-showcase.tsx | 236 |
| const | `ANIMATION_NAMES` | apps/tui/src/components/animation-showcase.tsx | 259 |
| function | `isValidAnimation` | apps/tui/src/components/animation-showcase.tsx | 261 |
| other | `VoiceIndicatorProps` | apps/tui/src/components/VoiceIndicator.tsx | 23 |
| function | `VoiceStatusBadge` | apps/tui/src/components/VoiceIndicator.tsx | 312 |
| other | `ImageAttachment` | apps/tui/src/components/image-input.tsx | 24 |
| other | `ImageInputProps` | apps/tui/src/components/image-input.tsx | 32 |
| function | `isImagePath` | apps/tui/src/components/image-input.tsx | 49 |
| function | `extractImagePaths` | apps/tui/src/components/image-input.tsx | 61 |
| function | `readImageFile` | apps/tui/src/components/image-input.tsx | 93 |
| function | `generateIterm2Image` | apps/tui/src/components/image-input.tsx | 143 |
| function | `supportsIterm2Images` | apps/tui/src/components/image-input.tsx | 162 |
| function | `ImageIndicator` | apps/tui/src/components/image-input.tsx | 196 |
| function | `ImageInput` | apps/tui/src/components/image-input.tsx | 229 |
| other | `UseImageInputOptions` | apps/tui/src/components/image-input.tsx | 273 |
| other | `GentlemanInputProps` | apps/tui/src/components/gentleman-input.tsx | 27 |
| function | `GentlemanInput` | apps/tui/src/components/gentleman-input.tsx | 49 |
| function | `GentlemanInputMinimal` | apps/tui/src/components/gentleman-input.tsx | 307 |
| other | `TaskCardListProps` | apps/tui/src/components/task-card/TaskCardList.tsx | 14 |
| other | `TaskCardListProps` | apps/tui/src/components/task-card/index.ts | 2 |
| other | `CardProps` | apps/tui/src/components/primitives/Card.tsx | 5 |
| other | `DividerProps` | apps/tui/src/components/primitives/Divider.tsx | 4 |
| type | `StatusType` | apps/tui/src/components/primitives/StatusDot.tsx | 4 |
| other | `StatusDotProps` | apps/tui/src/components/primitives/StatusDot.tsx | 6 |
| other | `LabelProps` | apps/tui/src/components/primitives/AppText.tsx | 20 |
| other | `StackProps` | apps/tui/src/components/primitives/Stack.tsx | 4 |
| other | `InlineProps` | apps/tui/src/components/primitives/Inline.tsx | 4 |
| other | `ShortcutHintProps` | apps/tui/src/components/primitives/ShortcutHint.tsx | 4 |
| other | `BadgeProps` | apps/tui/src/components/primitives/Badge.tsx | 4 |
| other | `NarratorProps` | apps/tui/src/components/narrator/Narrator.tsx | 4 |
| other | `NarratorProps` | apps/tui/src/components/narrator/index.ts | 1 |
| function | `OnboardingScreen` | apps/tui/src/screens/OnboardingScreen.tsx | 12 |
| other | `ProjectEntry` | apps/tui/src/screens/ProjectsView.tsx | 26 |
| other | `ProjectsViewProps` | apps/tui/src/screens/ProjectsView.tsx | 46 |
| function | `ChatScreen` | apps/tui/src/screens/ChatScreen.tsx | 11 |
| function | `HistoryScreen` | apps/tui/src/screens/HistoryScreen.tsx | 51 |
| other | `ChatScreen` | apps/tui/src/screens/index.ts | 1 |
| other | `HistoryScreen` | apps/tui/src/screens/index.ts | 2 |
| other | `NarratorViewProps` | apps/tui/src/screens/index.ts | 3 |
| other | `OnboardingScreen` | apps/tui/src/screens/index.ts | 4 |
| other | `NarratorViewProps` | apps/tui/src/screens/NarratorView.tsx | 13 |
| function | `AppProviders` | apps/tui/src/app/providers.tsx | 11 |

### benchmarks/fixtures (129)

| Kind | Name | File | Line |
|------|------|------|------|
| class | `DesignDB` | benchmarks/fixtures/design-db.ts | 9 |
| other | `DesignTokenRow` | benchmarks/fixtures/design-db.ts | 66 |
| other | `ComponentRow` | benchmarks/fixtures/design-db.ts | 77 |
| other | `VariantRow` | benchmarks/fixtures/design-db.ts | 88 |
| other | `ThemeRow` | benchmarks/fixtures/design-db.ts | 96 |
| other | `ThemeTokenRow` | benchmarks/fixtures/design-db.ts | 104 |
| function | `uid` | benchmarks/fixtures/design-db.ts | 114 |
| const | `CUSTOMERS_CSV` | benchmarks/fixtures/etl-data.ts | 6 |
| const | `PRODUCTS_CSV` | benchmarks/fixtures/etl-data.ts | 24 |
| const | `ORDERS_CSV` | benchmarks/fixtures/etl-data.ts | 34 |
| other | `HttpRequest` | benchmarks/fixtures/http.ts | 6 |
| other | `HttpResponse` | benchmarks/fixtures/http.ts | 17 |
| type | `Handler` | benchmarks/fixtures/http.ts | 23 |
| type | `Middleware` | benchmarks/fixtures/http.ts | 24 |
| other | `MockStat` | benchmarks/fixtures/mock-git.ts | 12 |
| other | `MockDirEntry` | benchmarks/fixtures/mock-git.ts | 18 |
| other | `Session` | benchmarks/fixtures/database.ts | 14 |
| function | `hashPassword` | benchmarks/fixtures/database.ts | 100 |
| function | `generateToken` | benchmarks/fixtures/database.ts | 119 |
| const | `HOLDOUT_PAIRS` | benchmarks/fixtures/re-pairs.ts | 170 |
| function | `extractStyleBlocks` | benchmarks/fixtures/ui-helpers.ts | 7 |
| function | `countElements` | benchmarks/fixtures/ui-helpers.ts | 31 |
| function | `hasProperty` | benchmarks/fixtures/ui-helpers.ts | 38 |
| function | `getPropertyValues` | benchmarks/fixtures/ui-helpers.ts | 45 |
| function | `hasKeyframes` | benchmarks/fixtures/ui-helpers.ts | 57 |
| function | `countKeyframes` | benchmarks/fixtures/ui-helpers.ts | 67 |
| function | `hasMediaQuery` | benchmarks/fixtures/ui-helpers.ts | 73 |
| function | `countMediaQueries` | benchmarks/fixtures/ui-helpers.ts | 78 |
| function | `hasPseudoClass` | benchmarks/fixtures/ui-helpers.ts | 84 |
| function | `hasPseudoElement` | benchmarks/fixtures/ui-helpers.ts | 92 |
| function | `hasSelector` | benchmarks/fixtures/ui-helpers.ts | 99 |
| function | `parseCSSNumericValue` | benchmarks/fixtures/ui-helpers.ts | 106 |
| function | `extractBlurValue` | benchmarks/fixtures/ui-helpers.ts | 115 |
| function | `extractRGBA` | benchmarks/fixtures/ui-helpers.ts | 122 |
| function | `relativeLuminance` | benchmarks/fixtures/ui-helpers.ts | 138 |
| function | `contrastRatio` | benchmarks/fixtures/ui-helpers.ts | 147 |
| function | `hasInsetShadow` | benchmarks/fixtures/ui-helpers.ts | 154 |
| function | `countShadowLayers` | benchmarks/fixtures/ui-helpers.ts | 160 |
| function | `hasCustomProperties` | benchmarks/fixtures/ui-helpers.ts | 174 |
| function | `countCustomProperties` | benchmarks/fixtures/ui-helpers.ts | 179 |
| function | `processOrder` | benchmarks/fixtures/file-manipulation/FM003-extract-function.ts | 21 |
| function | `createUser` | benchmarks/fixtures/file-manipulation/FM001-basic-edit.ts | 14 |
| function | `deleteUser` | benchmarks/fixtures/file-manipulation/FM001-basic-edit.ts | 23 |
| class | `Calculator` | benchmarks/fixtures/file-manipulation/FM002-refactor-class.ts | 7 |
| other | `Session` | benchmarks/fixtures/test-generation/TG002-auth-service.ts | 26 |
| other | `AuthResult` | benchmarks/fixtures/test-generation/TG002-auth-service.ts | 36 |
| function | `register` | benchmarks/fixtures/test-generation/TG002-auth-service.ts | 91 |
| function | `validateSession` | benchmarks/fixtures/test-generation/TG002-auth-service.ts | 204 |
| function | `changePassword` | benchmarks/fixtures/test-generation/TG002-auth-service.ts | 240 |
| function | `enableMfa` | benchmarks/fixtures/test-generation/TG002-auth-service.ts | 270 |
| function | `resetForTesting` | benchmarks/fixtures/test-generation/TG002-auth-service.ts | 289 |
| type | `EventHandler` | benchmarks/fixtures/test-generation/TG003-event-emitter.ts | 13 |
| type | `WildcardHandler` | benchmarks/fixtures/test-generation/TG003-event-emitter.ts | 14 |
| other | `EventSubscription` | benchmarks/fixtures/test-generation/TG003-event-emitter.ts | 16 |
| other | `EmitterStats` | benchmarks/fixtures/test-generation/TG003-event-emitter.ts | 20 |
| class | `TypedEventEmitter` | benchmarks/fixtures/test-generation/TG003-event-emitter.ts | 26 |
| type | `Operation` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 12 |
| other | `CalculatorResult` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 14 |
| other | `CalculatorHistory` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 21 |
| function | `subtract` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 47 |
| function | `multiply` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 58 |
| function | `divide` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 69 |
| function | `power` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 83 |
| function | `modulo` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 97 |
| function | `getHistory` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 111 |
| function | `clearHistory` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 115 |
| function | `calculate` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 120 |
| function | `calculateChain` | benchmarks/fixtures/test-generation/TG001-calculator.ts | 139 |
| class | `RequestHandler` | benchmarks/fixtures/feature-implementation/FI002-add-middleware.ts | 28 |
| class | `DataFetcher` | benchmarks/fixtures/feature-implementation/FI001-add-caching.ts | 18 |
| function | `updateCounter` | benchmarks/fixtures/bug-fixing/BF001-async-race.ts | 15 |
| function | `getCounter` | benchmarks/fixtures/bug-fixing/BF001-async-race.ts | 28 |
| function | `resetCounter` | benchmarks/fixtures/bug-fixing/BF001-async-race.ts | 32 |
| function | `demonstrateBug` | benchmarks/fixtures/bug-fixing/BF001-async-race.ts | 39 |
| function | `getEmailDomain` | benchmarks/fixtures/bug-fixing/BF003-null-check.ts | 28 |
| function | `getCompanyCity` | benchmarks/fixtures/bug-fixing/BF003-null-check.ts | 33 |
| function | `getFirstTag` | benchmarks/fixtures/bug-fixing/BF003-null-check.ts | 38 |
| function | `formatPersonInfo` | benchmarks/fixtures/bug-fixing/BF003-null-check.ts | 43 |
| function | `countTagsWithPrefix` | benchmarks/fixtures/bug-fixing/BF003-null-check.ts | 52 |
| const | `testData` | benchmarks/fixtures/bug-fixing/BF003-null-check.ts | 57 |
| class | `DataSubscriber` | benchmarks/fixtures/bug-fixing/BF002-memory-leak.ts | 35 |
| function | `demonstrateLeak` | benchmarks/fixtures/bug-fixing/BF002-memory-leak.ts | 61 |
| function | `range` | benchmarks/fixtures/bug-fixing/BF004-off-by-one.ts | 9 |
| function | `getLastN` | benchmarks/fixtures/bug-fixing/BF004-off-by-one.ts | 20 |
| function | `paginate` | benchmarks/fixtures/bug-fixing/BF004-off-by-one.ts | 31 |
| function | `findMiddle` | benchmarks/fixtures/bug-fixing/BF004-off-by-one.ts | 40 |
| function | `binarySearch` | benchmarks/fixtures/bug-fixing/BF004-off-by-one.ts | 51 |
| function | `runTests` | benchmarks/fixtures/bug-fixing/BF004-off-by-one.ts | 71 |
| function | `processUserData` | benchmarks/fixtures/code-review/CR003-code-smells.ts | 11 |
| function | `calculatePrice` | benchmarks/fixtures/code-review/CR003-code-smells.ts | 63 |
| function | `validateOrder` | benchmarks/fixtures/code-review/CR003-code-smells.ts | 91 |
| function | `formatUserForApi` | benchmarks/fixtures/code-review/CR003-code-smells.ts | 142 |
| function | `formatAdminForApi` | benchmarks/fixtures/code-review/CR003-code-smells.ts | 152 |
| function | `createNotification` | benchmarks/fixtures/code-review/CR003-code-smells.ts | 165 |
| function | `fetchData` | benchmarks/fixtures/code-review/CR003-code-smells.ts | 194 |
| function | `registerUser` | benchmarks/fixtures/code-review/CR001-security-issues.ts | 15 |
| function | `findUsersByQuery` | benchmarks/fixtures/code-review/CR001-security-issues.ts | 29 |
| function | `readUserFile` | benchmarks/fixtures/code-review/CR001-security-issues.ts | 41 |
| function | `handleApiRequest` | benchmarks/fixtures/code-review/CR001-security-issues.ts | 48 |
| function | `generateResetToken` | benchmarks/fixtures/code-review/CR001-security-issues.ts | 73 |
| function | `logAction` | benchmarks/fixtures/code-review/CR001-security-issues.ts | 79 |
| function | `getCorsHeaders` | benchmarks/fixtures/code-review/CR001-security-issues.ts | 84 |
| function | `findProductsByCategory` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 26 |
| function | `findProductsByCategories` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 36 |
| function | `getOrdersWithProducts` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 45 |
| function | `calculateOrderStats` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 56 |
| function | `buildProductCatalog` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 71 |
| function | `processProducts` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 85 |
| function | `findProduct` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 99 |
| function | `findProducts` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 108 |
| function | `expensiveOperation` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 115 |
| function | `analyzeProducts` | benchmarks/fixtures/code-review/CR002-performance-issues.ts | 123 |
| type | `LifecycleHook` | benchmarks/fixtures/broker-system/broker.ts | 43 |
| class | `MessageBroker` | benchmarks/fixtures/broker-system/broker.ts | 47 |
| function | `createApi` | benchmarks/fixtures/multi-file/MF001-api-client/index.ts | 10 |
| function | `get` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 105 |
| function | `post` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 110 |
| function | `put` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 114 |
| function | `patch` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 118 |
| function | `del` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 122 |
| function | `getPaginated` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 126 |
| function | `getAllPages` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 135 |
| function | `wrapResult` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 153 |
| function | `batch` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 166 |
| other | `HttpError` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 193 |
| other | `QueryParams` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 193 |
| other | `PaginatedResponse` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 193 |
| other | `ApiError` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 193 |
| other | `ApiResult` | benchmarks/fixtures/documentation/DOC001-api-module.ts | 193 |

### packages/memory (87)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `sanitize` | packages/memory/sanitize.ts | 7 |
| function | `generateRepresentation` | packages/memory/representations.ts | 32 |
| other | `AutoInjectConfig` | packages/memory/auto-inject.ts | 15 |
| function | `buildMemoryContext` | packages/memory/auto-inject.ts | 24 |
| function | `redact` | packages/memory/redact.ts | 32 |
| class | `OllamaEmbeddingProvider` | packages/memory/embeddings.ts | 26 |
| class | `NullEmbeddingProvider` | packages/memory/embeddings.ts | 139 |
| function | `resetEmbeddingProvider` | packages/memory/embeddings.ts | 174 |
| function | `stripInjectedContext` | packages/memory/extractor.ts | 479 |
| type | `MemoryScope` | packages/memory/types.ts | 16 |
| type | `LearningType` | packages/memory/types.ts | 20 |
| type | `SourceType` | packages/memory/types.ts | 22 |
| type | `SemanticCategory` | packages/memory/types.ts | 31 |
| type | `CoreCategory` | packages/memory/types.ts | 41 |
| type | `MemoryRelationshipType` | packages/memory/types.ts | 73 |
| other | `MemoryBase` | packages/memory/types.ts | 84 |
| other | `CoreMemory` | packages/memory/types.ts | 106 |
| other | `EpisodicMemory` | packages/memory/types.ts | 118 |
| other | `SemanticMemory` | packages/memory/types.ts | 129 |
| other | `ProceduralStep` | packages/memory/types.ts | 142 |
| other | `ProceduralMemory` | packages/memory/types.ts | 149 |
| other | `WorkingMemory` | packages/memory/types.ts | 160 |
| other | `ContextWindowOptions` | packages/memory/types.ts | 194 |
| other | `ContextEntry` | packages/memory/types.ts | 202 |
| other | `ContextWindow` | packages/memory/types.ts | 211 |
| other | `MemoryWithEvidence` | packages/memory/types.ts | 250 |
| other | `V1MemoryEntry` | packages/memory/types.ts | 270 |
| other | `V1RecallResult` | packages/memory/types.ts | 280 |
| function | `effectiveImportance` | packages/memory/types.ts | 312 |
| const | `CONSOLIDATION_PROMPT` | packages/memory/consolidation.ts | 17 |
| other | `ConsolidationResult` | packages/memory/consolidation.ts | 25 |
| function | `ensureConsolidationSchema` | packages/memory/consolidation.ts | 49 |
| function | `consolidate` | packages/memory/consolidation.ts | 67 |
| other | `PatternQuery` | packages/memory/graph.ts | 67 |
| function | `askMemory` | packages/memory/ask.ts | 27 |
| other | `MemoryHealth` | packages/memory/health.ts | 7 |
| function | `memoryHealth` | packages/memory/health.ts | 19 |
| other | `Contradiction` | packages/memory/contradictions.ts | 8 |
| function | `detectContradictions` | packages/memory/contradictions.ts | 17 |
| function | `resolveContradiction` | packages/memory/contradictions.ts | 106 |
| other | `memoryHealth` | packages/memory/index.ts | 107 |
| other | `MemoryHealth` | packages/memory/index.ts | 107 |
| other | `checkpoint` | packages/memory/index.ts | 108 |
| other | `rollback` | packages/memory/index.ts | 108 |
| other | `listCheckpoints` | packages/memory/index.ts | 108 |
| other | `detectContradictions` | packages/memory/index.ts | 109 |
| other | `resolveContradiction` | packages/memory/index.ts | 109 |
| other | `Contradiction` | packages/memory/index.ts | 109 |
| other | `recordProcedure` | packages/memory/index.ts | 110 |
| other | `recordFailure` | packages/memory/index.ts | 110 |
| other | `findProcedures` | packages/memory/index.ts | 110 |
| other | `getTopProcedures` | packages/memory/index.ts | 110 |
| other | `ProceduralMemory` | packages/memory/index.ts | 110 |
| other | `enqueue` | packages/memory/index.ts | 111 |
| other | `acquireLease` | packages/memory/index.ts | 111 |
| other | `completeLease` | packages/memory/index.ts | 111 |
| other | `failLease` | packages/memory/index.ts | 111 |
| other | `pendingCount` | packages/memory/index.ts | 111 |
| other | `Job` | packages/memory/index.ts | 111 |
| type | `MemoryLayer` | packages/memory/index.ts | 134 |
| other | `MemoryEntry` | packages/memory/index.ts | 136 |
| other | `RecallResult` | packages/memory/index.ts | 145 |
| other | `RememberOptions` | packages/memory/index.ts | 152 |
| class | `MemoryManager` | packages/memory/index.ts | 166 |
| const | `getMemoryManagerV2` | packages/memory/index.ts | 1188 |
| function | `resetMemoryManager` | packages/memory/index.ts | 1190 |
| function | `checkpoint` | packages/memory/checkpoint.ts | 11 |
| function | `rollback` | packages/memory/checkpoint.ts | 29 |
| function | `listCheckpoints` | packages/memory/checkpoint.ts | 33 |
| other | `TenantScope` | packages/memory/tenant.ts | 11 |
| other | `TenantClause` | packages/memory/tenant.ts | 17 |
| function | `tenantWhere` | packages/memory/tenant.ts | 32 |
| function | `validateTenant` | packages/memory/tenant.ts | 62 |
| function | `applyTenantScope` | packages/memory/tenant.ts | 82 |
| other | `ProceduralMemory` | packages/memory/procedural.ts | 12 |
| function | `createProceduralTable` | packages/memory/procedural.ts | 25 |
| function | `recordProcedure` | packages/memory/procedural.ts | 42 |
| function | `recordFailure` | packages/memory/procedural.ts | 74 |
| function | `findProcedures` | packages/memory/procedural.ts | 105 |
| function | `getTopProcedures` | packages/memory/procedural.ts | 118 |
| other | `Job` | packages/memory/queue.ts | 11 |
| function | `createJobTable` | packages/memory/queue.ts | 25 |
| function | `enqueue` | packages/memory/queue.ts | 41 |
| function | `acquireLease` | packages/memory/queue.ts | 51 |
| function | `completeLease` | packages/memory/queue.ts | 74 |
| function | `failLease` | packages/memory/queue.ts | 87 |
| function | `pendingCount` | packages/memory/queue.ts | 100 |

### packages/tools (83)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `ImageInfo` | packages/tools/image.ts | 16 |
| other | `ImageDescription` | packages/tools/image.ts | 27 |
| function | `readImage` | packages/tools/image.ts | 45 |
| function | `resizeImage` | packages/tools/image.ts | 82 |
| function | `describeImage` | packages/tools/image.ts | 128 |
| function | `extractTextFromImage` | packages/tools/image.ts | 173 |
| function | `analyzeCodeScreenshot` | packages/tools/image.ts | 202 |
| function | `getImageMetadata` | packages/tools/image.ts | 220 |
| function | `convertImage` | packages/tools/image.ts | 255 |
| function | `isVisionModelAvailable` | packages/tools/image.ts | 286 |
| other | `FileEmbedding` | packages/tools/semantic-search.ts | 9 |
| other | `SemanticIndex` | packages/tools/semantic-search.ts | 21 |
| function | `buildIndex` | packages/tools/semantic-search.ts | 95 |
| function | `search` | packages/tools/semantic-search.ts | 129 |
| function | `formatResults` | packages/tools/semantic-search.ts | 149 |
| other | `NotebookCell` | packages/tools/notebook.ts | 15 |
| other | `NotebookOutput` | packages/tools/notebook.ts | 24 |
| other | `NotebookMetadata` | packages/tools/notebook.ts | 35 |
| other | `Notebook` | packages/tools/notebook.ts | 53 |
| other | `ParsedCell` | packages/tools/notebook.ts | 60 |
| other | `ParsedOutput` | packages/tools/notebook.ts | 69 |
| other | `NotebookInfo` | packages/tools/notebook.ts | 80 |
| function | `readNotebook` | packages/tools/notebook.ts | 97 |
| function | `getCell` | packages/tools/notebook.ts | 173 |
| function | `editCell` | packages/tools/notebook.ts | 227 |
| function | `insertCell` | packages/tools/notebook.ts | 264 |
| function | `deleteCell` | packages/tools/notebook.ts | 317 |
| function | `moveCell` | packages/tools/notebook.ts | 350 |
| function | `changeCellType` | packages/tools/notebook.ts | 390 |
| function | `clearAllOutputs` | packages/tools/notebook.ts | 436 |
| function | `createNotebook` | packages/tools/notebook.ts | 478 |
| function | `getNotebookSummary` | packages/tools/notebook.ts | 532 |
| other | `RateLimitConfig` | packages/tools/rate-limiter.ts | 8 |
| other | `PdfInfo` | packages/tools/pdf.ts | 16 |
| other | `PdfMetadata` | packages/tools/pdf.ts | 23 |
| other | `PdfPageContent` | packages/tools/pdf.ts | 34 |
| function | `readPdf` | packages/tools/pdf.ts | 48 |
| function | `readPdfPage` | packages/tools/pdf.ts | 94 |
| function | `getPdfMetadata` | packages/tools/pdf.ts | 137 |
| function | `searchPdf` | packages/tools/pdf.ts | 179 |
| function | `readPdfPageRange` | packages/tools/pdf.ts | 233 |
| other | `BackgroundTask` | packages/tools/background.ts | 16 |
| class | `BackgroundTaskManager` | packages/tools/background.ts | 52 |
| function | `resetBackgroundTaskManager` | packages/tools/background.ts | 479 |
| function | `formatTaskStatus` | packages/tools/background.ts | 493 |
| function | `formatTaskOutput` | packages/tools/background.ts | 513 |
| function | `browserOpen` | packages/tools/browser-use.ts | 58 |
| function | `browserState` | packages/tools/browser-use.ts | 72 |
| function | `browserScreenshot` | packages/tools/browser-use.ts | 79 |
| function | `browserTask` | packages/tools/browser-use.ts | 91 |
| function | `browserClick` | packages/tools/browser-use.ts | 106 |
| function | `browserType` | packages/tools/browser-use.ts | 113 |
| function | `browserEval` | packages/tools/browser-use.ts | 120 |
| function | `browserScroll` | packages/tools/browser-use.ts | 127 |
| function | `browserClose` | packages/tools/browser-use.ts | 137 |
| function | `browserSessions` | packages/tools/browser-use.ts | 144 |
| other | `WebFetchResult` | packages/tools/web.ts | 22 |
| other | `WebSearchOptions` | packages/tools/web.ts | 31 |
| other | `WebFetchOptions` | packages/tools/web.ts | 36 |
| function | `webFetch` | packages/tools/web.ts | 125 |
| function | `summarizeContent` | packages/tools/web.ts | 297 |
| function | `searchAndSummarize` | packages/tools/web.ts | 317 |
| function | `formatSearchResults` | packages/tools/web.ts | 349 |
| function | `formatFetchResult` | packages/tools/web.ts | 358 |
| function | `npmPublish` | packages/tools/actuators/publish.ts | 34 |
| function | `gitTagAndPush` | packages/tools/actuators/publish.ts | 72 |
| function | `createGitHubRelease` | packages/tools/actuators/publish.ts | 118 |
| function | `defaultConfig` | packages/tools/actuators/types.ts | 29 |
| function | `sendTelegram` | packages/tools/actuators/notify.ts | 16 |
| function | `postToGitHubIssue` | packages/tools/actuators/notify.ts | 65 |
| other | `defaultConfig` | packages/tools/actuators/index.ts | 15 |
| other | `deployToVercel` | packages/tools/actuators/index.ts | 18 |
| other | `deployToRailway` | packages/tools/actuators/index.ts | 18 |
| other | `deployToFly` | packages/tools/actuators/index.ts | 18 |
| other | `npmPublish` | packages/tools/actuators/index.ts | 21 |
| other | `gitTagAndPush` | packages/tools/actuators/index.ts | 21 |
| other | `createGitHubRelease` | packages/tools/actuators/index.ts | 21 |
| other | `sendTelegram` | packages/tools/actuators/index.ts | 24 |
| other | `postToGitHubIssue` | packages/tools/actuators/index.ts | 24 |
| function | `deployToVercel` | packages/tools/actuators/deploy.ts | 34 |
| function | `deployToRailway` | packages/tools/actuators/deploy.ts | 71 |
| function | `deployToFly` | packages/tools/actuators/deploy.ts | 108 |
| other | `PageResult` | packages/tools/browser/fetch-page.ts | 11 |

### packages/orchestration (80)

| Kind | Name | File | Line |
|------|------|------|------|
| class | `WorktreeMessaging` | packages/orchestration/worktree-messaging.ts | 12 |
| other | `MeshAgent` | packages/orchestration/agent-mesh.ts | 24 |
| other | `MeshMessage` | packages/orchestration/agent-mesh.ts | 37 |
| other | `ChatMessage` | packages/orchestration/orchestrator-bus.ts | 13 |
| other | `OrchestratedAgent` | packages/orchestration/orchestrator-bus.ts | 21 |
| other | `SpawnRequest` | packages/orchestration/orchestrator-bus.ts | 34 |
| type | `BusEvent` | packages/orchestration/orchestrator-bus.ts | 44 |
| other | `DelegationRequest` | packages/orchestration/delegation.ts | 15 |
| other | `DelegationContext` | packages/orchestration/delegation.ts | 22 |
| other | `DelegationConstraints` | packages/orchestration/delegation.ts | 30 |
| other | `DelegationResult` | packages/orchestration/delegation.ts | 39 |
| function | `generateDelegationPrompt` | packages/orchestration/delegation.ts | 59 |
| function | `generateHandoffPrompt` | packages/orchestration/delegation.ts | 103 |
| function | `generateDecompositionPrompt` | packages/orchestration/delegation.ts | 144 |
| class | `DelegationManager` | packages/orchestration/delegation.ts | 192 |
| function | `getDelegationManager` | packages/orchestration/delegation.ts | 345 |
| function | `resetDelegationManager` | packages/orchestration/delegation.ts | 352 |
| other | `MacroAction` | packages/orchestration/macro-actions.ts | 16 |
| other | `MacroActionPlan` | packages/orchestration/macro-actions.ts | 27 |
| other | `DecomposeContext` | packages/orchestration/macro-actions.ts | 34 |
| other | `PlanEstimate` | packages/orchestration/macro-actions.ts | 39 |
| function | `decompose` | packages/orchestration/macro-actions.ts | 64 |
| function | `findParallelGroups` | packages/orchestration/macro-actions.ts | 140 |
| function | `findCriticalPath` | packages/orchestration/macro-actions.ts | 215 |
| function | `estimatePlan` | packages/orchestration/macro-actions.ts | 276 |
| function | `buildPlan` | packages/orchestration/macro-actions.ts | 317 |
| function | `createAction` | packages/orchestration/macro-actions.ts | 334 |
| function | `formatPlan` | packages/orchestration/macro-actions.ts | 353 |
| other | `WorktreeInfo` | packages/orchestration/worktree-manager.ts | 17 |
| class | `WorktreeManager` | packages/orchestration/worktree-manager.ts | 25 |
| other | `WorktreePoolOptions` | packages/orchestration/worktree-pool-types.ts | 39 |
| class | `WorktreePool` | packages/orchestration/worktree-pool.ts | 27 |
| other | `TokenEvent` | packages/orchestration/throughput-tracker.ts | 19 |
| other | `ThroughputSnapshot` | packages/orchestration/throughput-tracker.ts | 31 |
| other | `DailyReport` | packages/orchestration/throughput-tracker.ts | 41 |
| other | `AgentUtilization` | packages/orchestration/throughput-tracker.ts | 50 |
| function | `getThroughputTracker` | packages/orchestration/throughput-tracker.ts | 337 |
| function | `resetThroughputTracker` | packages/orchestration/throughput-tracker.ts | 344 |
| type | `AgentStatus` | packages/orchestration/index.ts | 20 |
| other | `AgentTask` | packages/orchestration/index.ts | 22 |
| other | `SpawnedAgent` | packages/orchestration/index.ts | 46 |
| other | `SharedContext` | packages/orchestration/index.ts | 66 |
| other | `QueuedTask` | packages/orchestration/index.ts | 73 |
| class | `TaskQueue` | packages/orchestration/index.ts | 415 |
| function | `getAgentPool` | packages/orchestration/index.ts | 663 |
| function | `getTaskQueue` | packages/orchestration/index.ts | 670 |
| function | `resetOrchestration` | packages/orchestration/index.ts | 677 |
| function | `formatAgentStatus` | packages/orchestration/index.ts | 689 |
| function | `parseSpawnCommand` | packages/orchestration/index.ts | 710 |
| other | `PERSONAS` | packages/orchestration/index.ts | 787 |
| other | `WorktreeManager` | packages/orchestration/index.ts | 789 |
| other | `ContextManager` | packages/orchestration/index.ts | 793 |
| other | `getContextManager` | packages/orchestration/index.ts | 793 |
| other | `getThroughputTracker` | packages/orchestration/index.ts | 812 |
| other | `resetThroughputTracker` | packages/orchestration/index.ts | 812 |
| other | `WorktreePool` | packages/orchestration/index.ts | 816 |
| other | `WorktreeMessaging` | packages/orchestration/index.ts | 817 |
| type | `ContextPolicy` | packages/orchestration/context-manager.ts | 11 |
| other | `ContextSlice` | packages/orchestration/context-manager.ts | 13 |
| class | `ContextManager` | packages/orchestration/context-manager.ts | 30 |
| function | `getContextManager` | packages/orchestration/context-manager.ts | 237 |
| type | `SubAgentStatus` | packages/orchestration/subagent.ts | 16 |
| other | `SubAgentMessage` | packages/orchestration/subagent.ts | 55 |
| other | `SubAgentEvent` | packages/orchestration/subagent.ts | 63 |
| class | `SubAgentManager` | packages/orchestration/subagent.ts | 84 |
| function | `getSubAgentManager` | packages/orchestration/subagent.ts | 548 |
| function | `resetSubAgentManager` | packages/orchestration/subagent.ts | 558 |
| function | `formatSubAgentStatus` | packages/orchestration/subagent.ts | 569 |
| function | `formatSubAgentEvidence` | packages/orchestration/subagent.ts | 595 |
| type | `AgentRuntime` | packages/orchestration/universal-spawner.ts | 19 |
| other | `CLIAgentOptions` | packages/orchestration/universal-spawner.ts | 21 |
| other | `CLIAgentResult` | packages/orchestration/universal-spawner.ts | 28 |
| other | `RunningCLIAgent` | packages/orchestration/universal-spawner.ts | 38 |
| function | `spawnCLIAgent` | packages/orchestration/universal-spawner.ts | 73 |
| function | `getCLIAgent` | packages/orchestration/universal-spawner.ts | 227 |
| function | `listCLIAgents` | packages/orchestration/universal-spawner.ts | 231 |
| function | `getCLIAgentStatus` | packages/orchestration/universal-spawner.ts | 235 |
| function | `clearFinishedCLIAgents` | packages/orchestration/universal-spawner.ts | 270 |
| function | `resetCLIAgents` | packages/orchestration/universal-spawner.ts | 281 |
| const | `PERSONAS` | packages/orchestration/personas.ts | 21 |

### packages/db (74)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `DbUser` | packages/db/types.ts | 12 |
| other | `CreateUserInput` | packages/db/types.ts | 24 |
| other | `UpdateUserInput` | packages/db/types.ts | 32 |
| other | `DbSession` | packages/db/types.ts | 45 |
| other | `StartSessionInput` | packages/db/types.ts | 58 |
| other | `UpdateSessionInput` | packages/db/types.ts | 63 |
| other | `EndSessionInput` | packages/db/types.ts | 70 |
| other | `DbUsage` | packages/db/types.ts | 82 |
| other | `UsageSummary` | packages/db/types.ts | 92 |
| other | `DbPreferences` | packages/db/types.ts | 104 |
| other | `PreferencesInput` | packages/db/types.ts | 116 |
| const | `DEFAULT_PREFERENCES` | packages/db/types.ts | 126 |
| other | `ConvexClientConfig` | packages/db/client.ts | 21 |
| class | `ConvexClientWrapper` | packages/db/client.ts | 43 |
| function | `getConvexClient` | packages/db/client.ts | 236 |
| function | `withConvex` | packages/db/client.ts | 254 |
| other | `ConvexClient` | packages/db/client.ts | 267 |
| const | `getRecent` | packages/db/convex/conversations.ts | 18 |
| const | `getById` | packages/db/convex/conversations.ts | 37 |
| const | `search` | packages/db/convex/conversations.ts | 47 |
| const | `upsert` | packages/db/convex/conversations.ts | 78 |
| const | `updateCheckpoint` | packages/db/convex/conversations.ts | 121 |
| const | `getDaily` | packages/db/convex/usage.ts | 18 |
| const | `getRange` | packages/db/convex/usage.ts | 37 |
| const | `getMonthlySummary` | packages/db/convex/usage.ts | 61 |
| const | `recordDaily` | packages/db/convex/usage.ts | 122 |
| function | `getTodayDateString` | packages/db/convex/usage.ts | 178 |
| function | `getCurrentYearMonth` | packages/db/convex/usage.ts | 186 |
| const | `get` | packages/db/convex/tenants.ts | 42 |
| const | `getBySubdomain` | packages/db/convex/tenants.ts | 56 |
| const | `listAll` | packages/db/convex/tenants.ts | 69 |
| const | `update` | packages/db/convex/tenants.ts | 126 |
| const | `deleteTenant` | packages/db/convex/tenants.ts | 175 |
| const | `getAdminDashboard` | packages/db/convex/admin.ts | 44 |
| const | `getUserList` | packages/db/convex/admin.ts | 89 |
| const | `getSystemHealth` | packages/db/convex/admin.ts | 175 |
| const | `getUsageTimeseries` | packages/db/convex/admin.ts | 237 |
| const | `getRecentSessions` | packages/db/convex/admin.ts | 300 |
| const | `getUserDetail` | packages/db/convex/admin.ts | 329 |
| const | `get` | packages/db/convex/preferences.ts | 19 |
| const | `getCurrent` | packages/db/convex/preferences.ts | 33 |
| const | `getByClerkId` | packages/db/convex/preferences.ts | 58 |
| const | `set` | packages/db/convex/preferences.ts | 83 |
| const | `merge` | packages/db/convex/preferences.ts | 126 |
| const | `remove` | packages/db/convex/preferences.ts | 185 |
| const | `getByClerkId` | packages/db/convex/users.ts | 19 |
| const | `getByGithubUsername` | packages/db/convex/users.ts | 32 |
| const | `getCurrentUser` | packages/db/convex/users.ts | 48 |
| const | `createOrUpdate` | packages/db/convex/users.ts | 73 |
| const | `updateLastActive` | packages/db/convex/users.ts | 131 |
| const | `updatePlan` | packages/db/convex/users.ts | 152 |
| const | `deleteUser` | packages/db/convex/users.ts | 174 |
| const | `getRecent` | packages/db/convex/sessions.ts | 18 |
| const | `getById` | packages/db/convex/sessions.ts | 37 |
| const | `getOpenSessions` | packages/db/convex/sessions.ts | 48 |
| const | `getByDateRange` | packages/db/convex/sessions.ts | 64 |
| const | `start` | packages/db/convex/sessions.ts | 93 |
| const | `end` | packages/db/convex/sessions.ts | 118 |
| const | `updateCounts` | packages/db/convex/sessions.ts | 146 |
| const | `closeStale` | packages/db/convex/sessions.ts | 171 |
| type | `TableNames` | packages/db/convex/_generated/dataModel.d.ts | 23 |
| type | `Doc` | packages/db/convex/_generated/dataModel.d.ts | 30 |
| type | `QueryCtx` | packages/db/convex/_generated/server.d.ts | 107 |
| type | `MutationCtx` | packages/db/convex/_generated/server.d.ts | 115 |
| type | `ActionCtx` | packages/db/convex/_generated/server.d.ts | 123 |
| type | `DatabaseReader` | packages/db/convex/_generated/server.d.ts | 132 |
| type | `DatabaseWriter` | packages/db/convex/_generated/server.d.ts | 143 |
| const | `internalQuery` | packages/db/convex/_generated/server.js | 39 |
| const | `internalMutation` | packages/db/convex/_generated/server.js | 59 |
| const | `action` | packages/db/convex/_generated/server.js | 72 |
| const | `internalAction` | packages/db/convex/_generated/server.js | 80 |
| const | `httpAction` | packages/db/convex/_generated/server.js | 93 |
| const | `internal` | packages/db/convex/_generated/api.js | 22 |
| const | `components` | packages/db/convex/_generated/api.js | 23 |

### packages/design-systems (73)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `DesignSystem` | packages/design-systems/schema.ts | 94 |
| other | `ColorPalette` | packages/design-systems/schema.ts | 107 |
| other | `Typography` | packages/design-systems/schema.ts | 127 |
| other | `Component` | packages/design-systems/schema.ts | 139 |
| other | `StyleTag` | packages/design-systems/schema.ts | 149 |
| other | `ParsedColors` | packages/design-systems/schema.ts | 183 |
| other | `ParsedTypography` | packages/design-systems/schema.ts | 201 |
| const | `COLOR_PATTERNS` | packages/design-systems/radiant-patterns.ts | 31 |
| const | `LAYOUT_PATTERNS` | packages/design-systems/radiant-patterns.ts | 139 |
| const | `ANIMATION_PATTERNS` | packages/design-systems/radiant-patterns.ts | 225 |
| const | `COMPONENT_PATTERNS` | packages/design-systems/radiant-patterns.ts | 350 |
| const | `TYPOGRAPHY_PATTERNS` | packages/design-systems/radiant-patterns.ts | 573 |
| const | `VISUAL_EFFECTS` | packages/design-systems/radiant-patterns.ts | 636 |
| const | `RESPONSIVE_PATTERNS` | packages/design-systems/radiant-patterns.ts | 742 |
| type | `ShaderTag` | packages/design-systems/radiant-patterns.ts | 792 |
| type | `ShaderTechnique` | packages/design-systems/radiant-patterns.ts | 793 |
| other | `ShaderEntry` | packages/design-systems/radiant-patterns.ts | 795 |
| const | `SHADER_CATALOG` | packages/design-systems/radiant-patterns.ts | 807 |
| const | `INSPIRATION_PALETTES` | packages/design-systems/radiant-patterns.ts | 902 |
| const | `LAYOUT_TEMPLATES` | packages/design-systems/radiant-patterns.ts | 943 |
| function | `seedDatabase` | packages/design-systems/seed.ts | 216 |
| function | `getAllThemes` | packages/design-systems/extractor.ts | 1677 |
| function | `getThemeByName` | packages/design-systems/extractor.ts | 1684 |
| function | `filterByStyle` | packages/design-systems/extractor.ts | 1691 |
| function | `filterByMood` | packages/design-systems/extractor.ts | 1698 |
| function | `searchByTag` | packages/design-systems/extractor.ts | 1705 |
| function | `hslToCss` | packages/design-systems/extractor.ts | 1715 |
| other | `seedDatabase` | packages/design-systems/index.ts | 111 |
| other | `CompleteDesignSystem` | packages/design-systems/query.ts | 60 |
| other | `DesignSuggestion` | packages/design-systems/query.ts | 73 |
| function | `listAll` | packages/design-systems/query.ts | 86 |
| function | `findByMood` | packages/design-systems/query.ts | 132 |
| function | `findByTag` | packages/design-systems/query.ts | 139 |
| function | `search` | packages/design-systems/query.ts | 146 |
| function | `findSimilar` | packages/design-systems/query.ts | 398 |
| function | `generateCssVariables` | packages/design-systems/query.ts | 435 |
| function | `generateTailwindConfig` | packages/design-systems/query.ts | 472 |
| function | `getHexPalette` | packages/design-systems/query.ts | 510 |
| function | `random` | packages/design-systems/query.ts | 541 |
| function | `featured` | packages/design-systems/query.ts | 552 |
| function | `listStyles` | packages/design-systems/query.ts | 572 |
| function | `listMoods` | packages/design-systems/query.ts | 588 |
| function | `getDatabase` | packages/design-systems/db.ts | 50 |
| function | `closeDatabase` | packages/design-systems/db.ts | 60 |
| function | `insertDesignSystem` | packages/design-systems/db.ts | 71 |
| function | `getDesignSystemById` | packages/design-systems/db.ts | 90 |
| function | `getDesignSystemByName` | packages/design-systems/db.ts | 95 |
| function | `getAllDesignSystems` | packages/design-systems/db.ts | 100 |
| function | `getDesignSystemsByStyle` | packages/design-systems/db.ts | 105 |
| function | `getDesignSystemsByMood` | packages/design-systems/db.ts | 110 |
| function | `insertColorPalette` | packages/design-systems/db.ts | 119 |
| function | `getColorPaletteBySystemId` | packages/design-systems/db.ts | 153 |
| function | `insertTypography` | packages/design-systems/db.ts | 162 |
| function | `getTypographyBySystemId` | packages/design-systems/db.ts | 185 |
| function | `insertComponent` | packages/design-systems/db.ts | 194 |
| function | `getComponentsBySystemId` | packages/design-systems/db.ts | 214 |
| function | `getComponentByType` | packages/design-systems/db.ts | 219 |
| function | `insertStyleTag` | packages/design-systems/db.ts | 234 |
| function | `getTagsBySystemId` | packages/design-systems/db.ts | 243 |
| function | `getSystemsByTag` | packages/design-systems/db.ts | 249 |
| function | `searchDesignSystems` | packages/design-systems/db.ts | 262 |
| function | `insertDesignSystemWithRelations` | packages/design-systems/db.ts | 282 |
| function | `parseColorsJson` | packages/design-systems/db.ts | 320 |
| function | `parseTypographyJson` | packages/design-systems/db.ts | 324 |
| function | `hslToHex` | packages/design-systems/db.ts | 328 |
| function | `getDatabaseStats` | packages/design-systems/db.ts | 382 |
| const | `MOTION_PRINCIPLES` | packages/design-systems/animations.ts | 15 |
| const | `EASING` | packages/design-systems/animations.ts | 57 |
| const | `DURATION` | packages/design-systems/animations.ts | 106 |
| const | `PATTERNS` | packages/design-systems/animations.ts | 128 |
| const | `PERFORMANCE` | packages/design-systems/animations.ts | 368 |
| const | `REMOTION` | packages/design-systems/animations.ts | 400 |
| const | `QUICK_REFERENCE` | packages/design-systems/animations.ts | 427 |

### packages/eight (70)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `VisionConfig` | packages/eight/vision-router.ts | 56 |
| function | `saveVisionConfig` | packages/eight/vision-router.ts | 108 |
| function | `hasVisionSupport` | packages/eight/vision-router.ts | 435 |
| function | `getRecommendedOCRModels` | packages/eight/vision-router.ts | 446 |
| type | `MessageContent` | packages/eight/types.ts | 7 |
| other | `MessageContentPart` | packages/eight/types.ts | 9 |
| other | `ToolCall` | packages/eight/types.ts | 22 |
| other | `ContextWindow` | packages/eight/context-engineering.ts | 12 |
| other | `ContextPriority` | packages/eight/context-engineering.ts | 21 |
| other | `ContextSummary` | packages/eight/context-engineering.ts | 31 |
| function | `createContextWindow` | packages/eight/context-engineering.ts | 59 |
| function | `updateContextWindow` | packages/eight/context-engineering.ts | 73 |
| function | `hasContextRoom` | packages/eight/context-engineering.ts | 107 |
| function | `getContextUsage` | packages/eight/context-engineering.ts | 115 |
| function | `compressMessage` | packages/eight/context-engineering.ts | 126 |
| function | `compressToolResult` | packages/eight/context-engineering.ts | 154 |
| function | `createContextItem` | packages/eight/context-engineering.ts | 232 |
| function | `prioritizeContext` | packages/eight/context-engineering.ts | 256 |
| function | `selectContextItems` | packages/eight/context-engineering.ts | 270 |
| function | `applyPriorityDecay` | packages/eight/context-engineering.ts | 295 |
| function | `summarizeConversation` | packages/eight/context-engineering.ts | 309 |
| function | `formatContextSummary` | packages/eight/context-engineering.ts | 356 |
| function | `generateThinkingBlock` | packages/eight/context-engineering.ts | 385 |
| function | `parseThinkingBlock` | packages/eight/context-engineering.ts | 416 |
| other | `startREPL` | packages/eight/index.ts | 39 |
| other | `CurriculumStep` | packages/eight/curriculum.ts | 12 |
| other | `Curriculum` | packages/eight/curriculum.ts | 28 |
| class | `CurriculumRunner` | packages/eight/curriculum.ts | 41 |
| const | `BUILTIN_CURRICULA` | packages/eight/curriculum.ts | 366 |
| type | `AccessTier` | packages/eight/prompts/soul-layers.ts | 8 |
| other | `UserContext` | packages/eight/prompts/soul-layers.ts | 36 |
| function | `composeSoulPrompt` | packages/eight/prompts/soul-layers.ts | 47 |
| function | `determineTier` | packages/eight/prompts/soul-layers.ts | 80 |
| other | `composeSoulPrompt` | packages/eight/prompts/system-prompt.ts | 17 |
| other | `determineTier` | packages/eight/prompts/system-prompt.ts | 17 |
| other | `AccessTier` | packages/eight/prompts/system-prompt.ts | 17 |
| other | `UserContext` | packages/eight/prompts/system-prompt.ts | 17 |
| const | `IDENTITY_SEGMENT` | packages/eight/prompts/system-prompt.ts | 27 |
| const | `USER_CONTEXT_SEGMENT` | packages/eight/prompts/system-prompt.ts | 33 |
| const | `ARCHITECTURE_SEGMENT` | packages/eight/prompts/system-prompt.ts | 64 |
| const | `BMAD_SEGMENT` | packages/eight/prompts/system-prompt.ts | 80 |
| const | `TOOL_PATTERNS_SEGMENT` | packages/eight/prompts/system-prompt.ts | 113 |
| const | `ERROR_RECOVERY_SEGMENT` | packages/eight/prompts/system-prompt.ts | 149 |
| const | `THINKING_PATTERNS_SEGMENT` | packages/eight/prompts/system-prompt.ts | 162 |
| const | `COMPLETION_SEGMENT` | packages/eight/prompts/system-prompt.ts | 188 |
| const | `DESIGN_FIRST_SEGMENT` | packages/eight/prompts/system-prompt.ts | 200 |
| const | `SWE_PATTERNS_SEGMENT` | packages/eight/prompts/system-prompt.ts | 211 |
| const | `RULES_SEGMENT` | packages/eight/prompts/system-prompt.ts | 271 |
| function | `getFullSystemPrompt` | packages/eight/prompts/system-prompt.ts | 292 |
| const | `FULL_SYSTEM_PROMPT` | packages/eight/prompts/system-prompt.ts | 310 |
| function | `buildTieredSystemPrompt` | packages/eight/prompts/system-prompt.ts | 316 |
| const | `SUBAGENT_SYSTEM_PROMPT` | packages/eight/prompts/system-prompt.ts | 337 |
| const | `PLANNING_PROMPT` | packages/eight/prompts/system-prompt.ts | 359 |
| const | `VALIDATION_PROMPT` | packages/eight/prompts/system-prompt.ts | 378 |
| function | `compressContext` | packages/eight/prompts/system-prompt.ts | 397 |
| function | `buildContextualPrompt` | packages/eight/prompts/system-prompt.ts | 428 |
| function | `getTaskSpecificPrompt` | packages/eight/prompts/system-prompt.ts | 484 |
| const | `FILE_MANIPULATION_ENHANCED` | packages/eight/prompts/system-prompt.ts | 500 |
| const | `BUG_FIXING_ENHANCED` | packages/eight/prompts/system-prompt.ts | 523 |
| const | `FEATURE_IMPLEMENTATION_ENHANCED` | packages/eight/prompts/system-prompt.ts | 741 |
| other | `OpenRouterModel` | packages/eight/providers/openrouter.ts | 10 |
| other | `OpenRouterConfig` | packages/eight/providers/openrouter.ts | 24 |
| const | `FREE_MODELS` | packages/eight/providers/openrouter.ts | 31 |
| const | `DEFAULT_FREE_MODEL` | packages/eight/providers/openrouter.ts | 43 |
| class | `OpenRouterProvider` | packages/eight/providers/openrouter.ts | 45 |
| function | `getOpenRouterConfig` | packages/eight/providers/openrouter.ts | 163 |
| function | `getOpenRouterOnboardingMessage` | packages/eight/providers/openrouter.ts | 176 |
| other | `OllamaClient` | packages/eight/clients/index.ts | 10 |
| other | `LMStudioClient` | packages/eight/clients/index.ts | 11 |
| other | `OpenRouterClient` | packages/eight/clients/index.ts | 12 |

### packages/auth (68)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `requireAuth` | packages/auth/middleware.ts | 22 |
| function | `requirePlan` | packages/auth/middleware.ts | 45 |
| function | `authenticateRequest` | packages/auth/middleware.ts | 79 |
| function | `checkAuth` | packages/auth/middleware.ts | 115 |
| function | `hasPlan` | packages/auth/middleware.ts | 142 |
| class | `KeychainTokenStore` | packages/auth/token-store.ts | 46 |
| class | `EncryptedFileTokenStore` | packages/auth/token-store.ts | 173 |
| other | `GitHubUser` | packages/auth/github.ts | 20 |
| function | `createGitHubAuth` | packages/auth/github.ts | 298 |
| function | `formatDeviceFlowStatus` | packages/auth/device-flow.ts | 289 |
| other | `AuthCheck` | packages/auth/types.ts | 49 |
| type | `DeviceFlowState` | packages/auth/types.ts | 98 |
| other | `DeviceAuthorizationResponse` | packages/auth/types.ts | 116 |
| other | `DeviceTokenResponse` | packages/auth/types.ts | 126 |
| other | `DeviceTokenErrorResponse` | packages/auth/types.ts | 136 |
| other | `AuthConfig` | packages/auth/types.ts | 150 |
| const | `DEFAULT_AUTH_CONFIG` | packages/auth/types.ts | 172 |
| other | `AuthCallbacks` | packages/auth/types.ts | 203 |
| other | `CLIAuthResult` | packages/auth/cli-auth-server.ts | 16 |
| other | `CLIAuthCallbacks` | packages/auth/cli-auth-server.ts | 25 |
| function | `runCLIAuthFlow` | packages/auth/cli-auth-server.ts | 41 |
| other | `GitHubRepo` | packages/auth/github-tools.ts | 15 |
| other | `GitHubIssue` | packages/auth/github-tools.ts | 22 |
| other | `GitHubPR` | packages/auth/github-tools.ts | 28 |
| other | `RepoInfo` | packages/auth/github-tools.ts | 33 |
| function | `listRepos` | packages/auth/github-tools.ts | 59 |
| function | `getCurrentRepoInfo` | packages/auth/github-tools.ts | 92 |
| function | `listIssues` | packages/auth/github-tools.ts | 154 |
| function | `createIssue` | packages/auth/github-tools.ts | 187 |
| function | `createPR` | packages/auth/github-tools.ts | 222 |
| function | `listPRs` | packages/auth/github-tools.ts | 257 |
| function | `getCurrentBranch` | packages/auth/github-tools.ts | 286 |
| function | `getDefaultBranch` | packages/auth/github-tools.ts | 305 |
| other | `resolveAuthConfig` | packages/auth/index.ts | 42 |
| other | `isTokenExpired` | packages/auth/index.ts | 42 |
| other | `validateToken` | packages/auth/index.ts | 42 |
| other | `executeDeviceFlow` | packages/auth/index.ts | 43 |
| other | `formatDeviceFlowStatus` | packages/auth/index.ts | 43 |
| other | `getTokenStore` | packages/auth/index.ts | 44 |
| other | `KeychainTokenStore` | packages/auth/index.ts | 44 |
| other | `EncryptedFileTokenStore` | packages/auth/index.ts | 44 |
| other | `requireAuth` | packages/auth/index.ts | 45 |
| other | `requirePlan` | packages/auth/index.ts | 45 |
| other | `checkAuth` | packages/auth/index.ts | 45 |
| other | `hasPlan` | packages/auth/index.ts | 45 |
| other | `authenticateRequest` | packages/auth/index.ts | 45 |
| other | `runCLIAuthFlow` | packages/auth/index.ts | 46 |
| other | `CLIAuthResult` | packages/auth/index.ts | 46 |
| other | `CLIAuthCallbacks` | packages/auth/index.ts | 46 |
| other | `getGitHubAuth` | packages/auth/index.ts | 47 |
| other | `createGitHubAuth` | packages/auth/index.ts | 47 |
| other | `extractGitHubUsername` | packages/auth/index.ts | 47 |
| other | `GitHubAuth` | packages/auth/index.ts | 47 |
| other | `GitHubUser` | packages/auth/index.ts | 47 |
| other | `listRepos` | packages/auth/index.ts | 48 |
| other | `getCurrentRepoInfo` | packages/auth/index.ts | 48 |
| other | `createIssue` | packages/auth/index.ts | 48 |
| other | `listIssues` | packages/auth/index.ts | 48 |
| other | `createPR` | packages/auth/index.ts | 48 |
| other | `listPRs` | packages/auth/index.ts | 48 |
| other | `getCurrentBranch` | packages/auth/index.ts | 48 |
| other | `getDefaultBranch` | packages/auth/index.ts | 48 |
| class | `AuthManager` | packages/auth/index.ts | 55 |
| function | `initAuth` | packages/auth/index.ts | 436 |
| function | `login` | packages/auth/index.ts | 447 |
| function | `logout` | packages/auth/index.ts | 456 |
| function | `getUser` | packages/auth/index.ts | 464 |
| function | `isAuthenticated` | packages/auth/index.ts | 472 |

### packages/proactive (66)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `RevenueStream` | packages/proactive/revenue-engine.ts | 13 |
| function | `identifyRevenueStreams` | packages/proactive/revenue-engine.ts | 67 |
| function | `trackRevenue` | packages/proactive/revenue-engine.ts | 117 |
| function | `advanceStreamStatus` | packages/proactive/revenue-engine.ts | 132 |
| function | `getRevenueReport` | packages/proactive/revenue-engine.ts | 147 |
| other | `ResearchOptions` | packages/proactive/research-types.ts | 8 |
| other | `ResearchSource` | packages/proactive/research-types.ts | 21 |
| other | `ResearchPattern` | packages/proactive/research-types.ts | 31 |
| other | `ResearchReport` | packages/proactive/research-types.ts | 37 |
| other | `ResearchIteration` | packages/proactive/research-types.ts | 50 |
| function | `estimateEffort` | packages/proactive/deliverable-generator.ts | 35 |
| function | `planDeliverable` | packages/proactive/deliverable-generator.ts | 73 |
| function | `advanceDeliverable` | packages/proactive/deliverable-generator.ts | 110 |
| function | `isActionable` | packages/proactive/deliverable-generator.ts | 121 |
| function | `trackOpportunity` | packages/proactive/work-tracker.ts | 48 |
| function | `trackAll` | packages/proactive/work-tracker.ts | 62 |
| function | `getOpportunities` | packages/proactive/work-tracker.ts | 78 |
| function | `advanceStatus` | packages/proactive/work-tracker.ts | 88 |
| function | `pruneByStatus` | packages/proactive/work-tracker.ts | 104 |
| function | `getPipelineSummary` | packages/proactive/work-tracker.ts | 115 |
| function | `getTopOpportunities` | packages/proactive/work-tracker.ts | 134 |
| other | `MatchResult` | packages/proactive/capability-matcher.ts | 12 |
| const | `DEFAULT_CAPABILITIES` | packages/proactive/capability-matcher.ts | 74 |
| function | `evaluateOpportunity` | packages/proactive/capability-matcher.ts | 91 |
| function | `evaluateAll` | packages/proactive/capability-matcher.ts | 159 |
| function | `listJobs` | packages/proactive/cron-manager.ts | 51 |
| function | `addCronJob` | packages/proactive/cron-manager.ts | 57 |
| function | `removeCronJob` | packages/proactive/cron-manager.ts | 78 |
| function | `toggleJob` | packages/proactive/cron-manager.ts | 85 |
| const | `enableJob` | packages/proactive/cron-manager.ts | 100 |
| const | `disableJob` | packages/proactive/cron-manager.ts | 101 |
| function | `research` | packages/proactive/autoresearch.ts | 230 |
| other | `ClarifyingQuestion` | packages/proactive/index.ts | 25 |
| type | `QuestionCategory` | packages/proactive/index.ts | 36 |
| other | `GatheringState` | packages/proactive/index.ts | 45 |
| other | `ProactiveConfig` | packages/proactive/index.ts | 62 |
| other | `research` | packages/proactive/index.ts | 560 |
| type | `PackagingRuleName` | packages/proactive/content-packaging.ts | 20 |
| type | `FormulaName` | packages/proactive/content-packaging.ts | 29 |
| type | `Grade` | packages/proactive/content-packaging.ts | 36 |
| other | `PackagingRule` | packages/proactive/content-packaging.ts | 38 |
| other | `RuleScore` | packages/proactive/content-packaging.ts | 45 |
| other | `PackagingScore` | packages/proactive/content-packaging.ts | 52 |
| other | `AuditReport` | packages/proactive/content-packaging.ts | 59 |
| function | `scoreHook` | packages/proactive/content-packaging.ts | 195 |
| function | `diagnoseHook` | packages/proactive/content-packaging.ts | 214 |
| function | `applyFormula` | packages/proactive/content-packaging.ts | 219 |
| function | `repackage` | packages/proactive/content-packaging.ts | 226 |
| function | `auditBatch` | packages/proactive/content-packaging.ts | 233 |
| type | `BusinessAgentRole` | packages/proactive/business-agents.ts | 11 |
| type | `ScopingPhase` | packages/proactive/business-agents.ts | 15 |
| type | `BusinessScope` | packages/proactive/business-agents.ts | 30 |
| const | `BUSINESS_AGENTS` | packages/proactive/business-agents.ts | 49 |
| const | `SCOPING_PHASES` | packages/proactive/business-agents.ts | 114 |
| function | `getPhaseAgents` | packages/proactive/business-agents.ts | 126 |
| function | `getCollaborators` | packages/proactive/business-agents.ts | 131 |
| function | `getAgentPrompt` | packages/proactive/business-agents.ts | 138 |
| function | `scopeBusiness` | packages/proactive/business-agents.ts | 170 |
| function | `composeResponse` | packages/proactive/client-outreach.ts | 28 |
| function | `composePRDescription` | packages/proactive/client-outreach.ts | 47 |
| function | `composeProactiveOutreach` | packages/proactive/client-outreach.ts | 80 |
| function | `scanGitHubIssues` | packages/proactive/opportunity-scanner.ts | 79 |
| function | `scanGitHubDiscussions` | packages/proactive/opportunity-scanner.ts | 149 |
| function | `scanContributingSection` | packages/proactive/opportunity-scanner.ts | 221 |
| function | `scanCodeTodos` | packages/proactive/opportunity-scanner.ts | 290 |
| function | `scanLocalBacklog` | packages/proactive/opportunity-scanner.ts | 330 |

### packages/reporting (62)

| Kind | Name | File | Line |
|------|------|------|------|
| class | `ReportHistory` | packages/reporting/history.ts | 38 |
| other | `ReportStats` | packages/reporting/history.ts | 298 |
| function | `handleReportsCommand` | packages/reporting/history.ts | 313 |
| function | `handleReportCommand` | packages/reporting/history.ts | 328 |
| function | `getReportHistory` | packages/reporting/history.ts | 354 |
| function | `createHistory` | packages/reporting/history.ts | 361 |
| function | `getLogPath` | packages/reporting/runlog.ts | 72 |
| class | `AgentReportingContext` | packages/reporting/integration.ts | 34 |
| function | `handleReports` | packages/reporting/integration.ts | 246 |
| function | `handleReport` | packages/reporting/integration.ts | 254 |
| function | `isReportCommand` | packages/reporting/integration.ts | 262 |
| function | `handleReportCommands` | packages/reporting/integration.ts | 273 |
| function | `createReportingContext` | packages/reporting/integration.ts | 296 |
| function | `formatForVoice` | packages/reporting/integration.ts | 338 |
| function | `generateCompletionMarker` | packages/reporting/integration.ts | 404 |
| other | `StepSummary` | packages/reporting/types.ts | 11 |
| other | `EvidenceSummary` | packages/reporting/types.ts | 21 |
| other | `CompletionReport` | packages/reporting/types.ts | 29 |
| other | `FileOperation` | packages/reporting/types.ts | 83 |
| other | `ToolInvocation` | packages/reporting/types.ts | 89 |
| other | `TaskStep` | packages/reporting/types.ts | 98 |
| other | `TaskContext` | packages/reporting/types.ts | 109 |
| other | `StoredReport` | packages/reporting/types.ts | 151 |
| other | `ReportQuery` | packages/reporting/types.ts | 156 |
| other | `ReportListItem` | packages/reporting/types.ts | 165 |
| other | `getLogPath` | packages/reporting/index.ts | 37 |
| class | `TaskContextTracker` | packages/reporting/completion.ts | 555 |
| function | `createReporter` | packages/reporting/completion.ts | 672 |
| function | `createTracker` | packages/reporting/completion.ts | 676 |
| function | `getCompletionReporter` | packages/reporting/completion.ts | 687 |
| const | `boxChars` | packages/reporting/formatter.ts | 56 |
| function | `colorize` | packages/reporting/formatter.ts | 110 |
| function | `bold` | packages/reporting/formatter.ts | 114 |
| function | `dim` | packages/reporting/formatter.ts | 118 |
| function | `success` | packages/reporting/formatter.ts | 122 |
| function | `warning` | packages/reporting/formatter.ts | 126 |
| function | `error` | packages/reporting/formatter.ts | 130 |
| function | `info` | packages/reporting/formatter.ts | 134 |
| function | `muted` | packages/reporting/formatter.ts | 138 |
| other | `BoxOptions` | packages/reporting/formatter.ts | 146 |
| function | `box` | packages/reporting/formatter.ts | 156 |
| other | `TableOptions` | packages/reporting/formatter.ts | 244 |
| function | `table` | packages/reporting/formatter.ts | 251 |
| other | `ListOptions` | packages/reporting/formatter.ts | 315 |
| function | `list` | packages/reporting/formatter.ts | 321 |
| function | `numberedList` | packages/reporting/formatter.ts | 334 |
| function | `tree` | packages/reporting/formatter.ts | 346 |
| other | `TreeItem` | packages/reporting/formatter.ts | 366 |
| function | `statusLine` | packages/reporting/formatter.ts | 375 |
| function | `keyValueLine` | packages/reporting/formatter.ts | 379 |
| function | `divider` | packages/reporting/formatter.ts | 388 |
| function | `doubleDivider` | packages/reporting/formatter.ts | 392 |
| function | `dashedDivider` | packages/reporting/formatter.ts | 396 |
| function | `heading` | packages/reporting/formatter.ts | 404 |
| function | `sectionHeader` | packages/reporting/formatter.ts | 417 |
| function | `spinner` | packages/reporting/formatter.ts | 441 |
| function | `statusIcon` | packages/reporting/formatter.ts | 450 |
| function | `stepIcon` | packages/reporting/formatter.ts | 467 |
| function | `stripAnsi` | packages/reporting/formatter.ts | 487 |
| function | `wrapText` | packages/reporting/formatter.ts | 491 |
| function | `padCenter` | packages/reporting/formatter.ts | 527 |
| function | `formatNumber` | packages/reporting/formatter.ts | 557 |

### packages/workflow (46)

| Kind | Name | File | Line |
|------|------|------|------|
| type | `CommitType` | packages/workflow/git-workflow.ts | 12 |
| other | `ConventionalCommit` | packages/workflow/git-workflow.ts | 24 |
| other | `BranchConfig` | packages/workflow/git-workflow.ts | 34 |
| other | `PRDescription` | packages/workflow/git-workflow.ts | 40 |
| function | `inferCommitType` | packages/workflow/git-workflow.ts | 57 |
| function | `inferScope` | packages/workflow/git-workflow.ts | 94 |
| function | `generateCommitMessage` | packages/workflow/git-workflow.ts | 132 |
| function | `parseCommitMessage` | packages/workflow/git-workflow.ts | 170 |
| function | `generateBranchName` | packages/workflow/git-workflow.ts | 233 |
| function | `inferBranchPrefix` | packages/workflow/git-workflow.ts | 256 |
| function | `validateBranchName` | packages/workflow/git-workflow.ts | 272 |
| function | `generatePRDescription` | packages/workflow/git-workflow.ts | 310 |
| function | `formatPRDescription` | packages/workflow/git-workflow.ts | 396 |
| class | `GitWorkflowManager` | packages/workflow/git-workflow.ts | 446 |
| function | `getGitWorkflow` | packages/workflow/git-workflow.ts | 606 |
| function | `resetGitWorkflow` | packages/workflow/git-workflow.ts | 613 |
| type | `StepStatus` | packages/workflow/plan-validate.ts | 22 |
| other | `PlanValidateConfig` | packages/workflow/plan-validate.ts | 46 |
| other | `ExecutionOptions` | packages/workflow/plan-validate.ts | 55 |
| other | `ValidationResult` | packages/workflow/plan-validate.ts | 61 |
| class | `PlanValidateLoop` | packages/workflow/plan-validate.ts | 75 |
| class | `PlanBuilder` | packages/workflow/plan-validate.ts | 330 |
| function | `parsePlanFromResponse` | packages/workflow/plan-validate.ts | 376 |
| function | `formatPlan` | packages/workflow/plan-validate.ts | 449 |
| type | `BMadTaskSize` | packages/workflow/bmad-process.ts | 16 |
| other | `BMadTask` | packages/workflow/bmad-process.ts | 18 |
| type | `BMadStatus` | packages/workflow/bmad-process.ts | 38 |
| other | `AcceptanceCriterion` | packages/workflow/bmad-process.ts | 46 |
| other | `BMadStep` | packages/workflow/bmad-process.ts | 54 |
| other | `BMadColumn` | packages/workflow/bmad-process.ts | 64 |
| other | `BMadBoard` | packages/workflow/bmad-process.ts | 71 |
| function | `classifyTaskSize` | packages/workflow/bmad-process.ts | 83 |
| function | `generateAcceptanceCriteria` | packages/workflow/bmad-process.ts | 136 |
| function | `decomposeTask` | packages/workflow/bmad-process.ts | 195 |
| class | `KanbanBoard` | packages/workflow/bmad-process.ts | 263 |
| function | `getKanbanBoard` | packages/workflow/bmad-process.ts | 588 |
| function | `resetKanbanBoard` | packages/workflow/bmad-process.ts | 595 |
| type | `WorkflowPhase` | packages/workflow/proactive-infinite.ts | 34 |
| other | `WorkflowState` | packages/workflow/proactive-infinite.ts | 41 |
| other | `WorkflowConfig` | packages/workflow/proactive-infinite.ts | 51 |
| type | `WorkflowEvent` | packages/workflow/proactive-infinite.ts | 64 |
| class | `ProactiveInfiniteWorkflow` | packages/workflow/proactive-infinite.ts | 78 |
| function | `createWorkflow` | packages/workflow/proactive-infinite.ts | 308 |
| function | `runWorkflow` | packages/workflow/proactive-infinite.ts | 315 |
| const | `PROACTIVE_SYSTEM_ADDITION` | packages/workflow/proactive-infinite.ts | 375 |
| const | `INFINITE_OFFER_PROMPT` | packages/workflow/proactive-infinite.ts | 396 |

### packages/control-plane (43)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `calculateUserGrowth` | packages/control-plane/analytics.ts | 26 |
| function | `getActiveSessionCount` | packages/control-plane/analytics.ts | 65 |
| function | `aggregateTokenUsage` | packages/control-plane/analytics.ts | 78 |
| function | `calculateModelDistribution` | packages/control-plane/analytics.ts | 110 |
| function | `calculateProviderDistribution` | packages/control-plane/analytics.ts | 123 |
| function | `calculatePlanDistribution` | packages/control-plane/analytics.ts | 136 |
| function | `generateUsageReport` | packages/control-plane/analytics.ts | 153 |
| function | `getTopUsers` | packages/control-plane/analytics.ts | 243 |
| function | `calculateSystemHealth` | packages/control-plane/analytics.ts | 293 |
| other | `AdminDashboard` | packages/control-plane/types.ts | 57 |
| other | `DataPoint` | packages/control-plane/types.ts | 76 |
| type | `ReportPeriod` | packages/control-plane/types.ts | 87 |
| other | `UsageReport` | packages/control-plane/types.ts | 89 |
| other | `UserUsageStats` | packages/control-plane/types.ts | 108 |
| class | `ControlPlane` | packages/control-plane/index.ts | 72 |
| const | `controlPlane` | packages/control-plane/index.ts | 270 |
| other | `STRIPE_PRICE_IDS` | packages/control-plane/index.ts | 272 |
| const | `STRIPE_PRICE_IDS` | packages/control-plane/billing.ts | 53 |
| function | `getPlan` | packages/control-plane/billing.ts | 127 |
| function | `getPlanLimits` | packages/control-plane/billing.ts | 134 |
| function | `getPlanFeatures` | packages/control-plane/billing.ts | 141 |
| function | `checkPlanLimits` | packages/control-plane/billing.ts | 148 |
| function | `getUsageForBilling` | packages/control-plane/billing.ts | 174 |
| function | `estimateMonthlyRevenue` | packages/control-plane/billing.ts | 215 |
| function | `formatCents` | packages/control-plane/billing.ts | 228 |
| function | `createStripeCustomer` | packages/control-plane/billing.ts | 240 |
| function | `createStripeSubscription` | packages/control-plane/billing.ts | 264 |
| function | `cancelStripeSubscription` | packages/control-plane/billing.ts | 306 |
| function | `cancelStripeSubscriptionImmediately` | packages/control-plane/billing.ts | 330 |
| function | `getStripeBillingPortalUrl` | packages/control-plane/billing.ts | 475 |
| function | `getStripeCustomer` | packages/control-plane/billing.ts | 496 |
| function | `getStripeSubscription` | packages/control-plane/billing.ts | 513 |
| other | `TenantStore` | packages/control-plane/tenant.ts | 21 |
| class | `ConvexTenantStore` | packages/control-plane/tenant.ts | 94 |
| class | `InMemoryTenantStore` | packages/control-plane/tenant.ts | 183 |
| function | `createTenantStore` | packages/control-plane/tenant.ts | 287 |
| function | `checkUsageLimits` | packages/control-plane/tenant.ts | 306 |
| function | `isFeatureEnabled` | packages/control-plane/tenant.ts | 341 |
| function | `resolveSubdomain` | packages/control-plane/tenant.ts | 353 |
| function | `createHonoWebhookHandler` | packages/control-plane/stripe-webhook.ts | 45 |
| function | `createExpressWebhookHandler` | packages/control-plane/stripe-webhook.ts | 100 |
| function | `processStripeWebhook` | packages/control-plane/stripe-webhook.ts | 143 |
| other | `WebhookCallbacks` | packages/control-plane/stripe-webhook.ts | 169 |

### packages/personality (43)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `getBrandedHeader` | packages/personality/brand.ts | 107 |
| function | `getCompactHeader` | packages/personality/brand.ts | 114 |
| function | `brandText` | packages/personality/brand.ts | 121 |
| function | `getSpinnerFrame` | packages/personality/brand.ts | 129 |
| function | `getStatusIcon` | packages/personality/brand.ts | 136 |
| function | `createBrandedBox` | packages/personality/brand.ts | 145 |
| function | `createWelcomeBanner` | packages/personality/brand.ts | 165 |
| function | `createCompactWelcome` | packages/personality/brand.ts | 175 |
| type | `BrandColor` | packages/personality/brand.ts | 184 |
| type | `BrandIcon` | packages/personality/brand.ts | 185 |
| other | `Personality` | packages/personality/voice.ts | 12 |
| const | `PERSONALITY` | packages/personality/voice.ts | 24 |
| const | `GREETINGS` | packages/personality/voice.ts | 40 |
| const | `COMPLETION_PHRASES` | packages/personality/voice.ts | 59 |
| const | `ERROR_PHRASES` | packages/personality/voice.ts | 80 |
| const | `IDLE_QUIPS` | packages/personality/voice.ts | 99 |
| const | `THINKING_PHRASES` | packages/personality/voice.ts | 116 |
| const | `PROGRESS_PHRASES` | packages/personality/voice.ts | 131 |
| const | `REFINED_AFFIRMATIVES` | packages/personality/voice.ts | 146 |
| const | `REFINED_TRANSITIONS` | packages/personality/voice.ts | 159 |
| function | `getRandomPhrase` | packages/personality/voice.ts | 179 |
| function | `getGreeting` | packages/personality/voice.ts | 188 |
| function | `getCompletionPhrase` | packages/personality/voice.ts | 195 |
| function | `getErrorPhrase` | packages/personality/voice.ts | 202 |
| function | `getIdleQuip` | packages/personality/voice.ts | 209 |
| function | `getThinkingPhrase` | packages/personality/voice.ts | 216 |
| function | `getProgressPhrase` | packages/personality/voice.ts | 223 |
| function | `getAffirmative` | packages/personality/voice.ts | 230 |
| other | `FlavoredResponse` | packages/personality/voice.ts | 238 |
| function | `flavorResponse` | packages/personality/voice.ts | 247 |
| function | `createGreetingResponse` | packages/personality/voice.ts | 267 |
| function | `createCompletionResponse` | packages/personality/voice.ts | 278 |
| function | `createErrorResponse` | packages/personality/voice.ts | 286 |
| class | `Voice` | packages/personality/voice.ts | 299 |
| const | `voice` | packages/personality/voice.ts | 380 |
| const | `THINKING_VERBS` | packages/personality/status-verbs.ts | 12 |
| const | `EXECUTING_VERBS` | packages/personality/status-verbs.ts | 68 |
| const | `PLANNING_VERBS` | packages/personality/status-verbs.ts | 90 |
| function | `getRandomVerb` | packages/personality/status-verbs.ts | 120 |
| function | `getVerbsForType` | packages/personality/status-verbs.ts | 128 |
| function | `getNextVerb` | packages/personality/status-verbs.ts | 144 |
| class | `StatusVerbs` | packages/personality/status-verbs.ts | 162 |
| const | `statusVerbs` | packages/personality/status-verbs.ts | 249 |

### packages/voice (42)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `CloudTranscriberOptions` | packages/voice/cloud-transcriber.ts | 11 |
| other | `VADOptions` | packages/voice/vad.ts | 8 |
| type | `VADState` | packages/voice/vad.ts | 19 |
| other | `VADEvents` | packages/voice/vad.ts | 21 |
| function | `isLocalTTSAvailable` | packages/voice/tts-client.ts | 24 |
| function | `cloneVoice` | packages/voice/tts-client.ts | 34 |
| function | `generateSpeech` | packages/voice/tts-client.ts | 83 |
| function | `listProfiles` | packages/voice/tts-client.ts | 100 |
| function | `speak` | packages/voice/tts-client.ts | 115 |
| other | `ModelManagerEvents` | packages/voice/model-manager.ts | 18 |
| function | `resolveModelsPath` | packages/voice/model-manager.ts | 28 |
| other | `VoiceChatConfig` | packages/voice/voice-chat.ts | 36 |
| other | `VoiceChatEvents` | packages/voice/voice-chat.ts | 55 |
| other | `VoiceConfig` | packages/voice/types.ts | 11 |
| const | `DEFAULT_VOICE_CONFIG` | packages/voice/types.ts | 34 |
| other | `WhisperModelInfo` | packages/voice/types.ts | 52 |
| const | `WHISPER_MODELS` | packages/voice/types.ts | 69 |
| other | `RecordingStatus` | packages/voice/types.ts | 108 |
| type | `VoiceEventMap` | packages/voice/types.ts | 139 |
| type | `VoiceErrorCode` | packages/voice/types.ts | 151 |
| other | `DependencyCheckResult` | packages/voice/types.ts | 168 |
| other | `TTSSpeakOptions` | packages/voice/tts-engine.ts | 16 |
| type | `TTSProviderName` | packages/voice/tts-engine.ts | 29 |
| other | `TTSProvider` | packages/voice/tts-engine.ts | 31 |
| class | `MacOSTTSProvider` | packages/voice/tts-engine.ts | 43 |
| class | `KittenTTSProvider` | packages/voice/tts-engine.ts | 94 |
| function | `setTTSEngine` | packages/voice/tts-engine.ts | 287 |
| other | `RecorderOptions` | packages/voice/recorder.ts | 14 |
| other | `RecorderEvents` | packages/voice/recorder.ts | 27 |
| function | `findSoxPath` | packages/voice/recorder.ts | 37 |
| function | `getWhisperBinaryPath` | packages/voice/transcriber.ts | 21 |
| function | `installWhisperCpp` | packages/voice/transcriber.ts | 64 |
| other | `TranscriberOptions` | packages/voice/transcriber.ts | 91 |
| other | `WhisperModelManager` | packages/voice/index.ts | 44 |
| other | `MicRecorder` | packages/voice/index.ts | 45 |
| other | `checkSoxInstalled` | packages/voice/index.ts | 45 |
| other | `findWhisperBinary` | packages/voice/index.ts | 46 |
| other | `transcribeLocal` | packages/voice/index.ts | 46 |
| other | `transcribeCloud` | packages/voice/index.ts | 47 |
| other | `isCloudAvailable` | packages/voice/index.ts | 47 |
| other | `VoiceActivityDetector` | packages/voice/index.ts | 48 |
| other | `VoiceChatConfig` | packages/voice/index.ts | 49 |

### packages/telegram-bot (42)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `PortalCommand` | packages/telegram-bot/unified-portal.ts | 16 |
| function | `formatForTelegram` | packages/telegram-bot/unified-portal.ts | 45 |
| class | `UnifiedPortal` | packages/telegram-bot/unified-portal.ts | 99 |
| other | `TelegramResponse` | packages/telegram-bot/types.ts | 10 |
| other | `TelegramMessage` | packages/telegram-bot/types.ts | 17 |
| other | `TelegramUser` | packages/telegram-bot/types.ts | 25 |
| other | `TelegramChat` | packages/telegram-bot/types.ts | 33 |
| other | `TelegramUpdate` | packages/telegram-bot/types.ts | 40 |
| other | `TelegramCallbackQuery` | packages/telegram-bot/types.ts | 46 |
| other | `InlineKeyboardButton` | packages/telegram-bot/types.ts | 53 |
| other | `InlineKeyboardMarkup` | packages/telegram-bot/types.ts | 59 |
| other | `SendMessageOptions` | packages/telegram-bot/types.ts | 63 |
| other | `BenchmarkScore` | packages/telegram-bot/types.ts | 71 |
| other | `OvernightSummary` | packages/telegram-bot/types.ts | 132 |
| type | `AlertSeverity` | packages/telegram-bot/types.ts | 155 |
| other | `Alert` | packages/telegram-bot/types.ts | 157 |
| type | `CommandHandler` | packages/telegram-bot/types.ts | 183 |
| other | `TelegramBotConfig` | packages/telegram-bot/types.ts | 197 |
| other | `ConversationEntry` | packages/telegram-bot/types.ts | 230 |
| other | `RepoEntry` | packages/telegram-bot/types.ts | 237 |
| other | `Learning` | packages/telegram-bot/types.ts | 246 |
| other | `BotMemoryData` | packages/telegram-bot/types.ts | 253 |
| other | `TrendingRepo` | packages/telegram-bot/intelligence.ts | 14 |
| other | `RepoEntry` | packages/telegram-bot/intelligence.ts | 28 |
| function | `quickSend` | packages/telegram-bot/index.ts | 480 |
| function | `createBot` | packages/telegram-bot/index.ts | 488 |
| other | `commands` | packages/telegram-bot/index.ts | 529 |
| other | `routeCommand` | packages/telegram-bot/index.ts | 529 |
| other | `TelegramAgentMode` | packages/telegram-bot/index.ts | 530 |
| other | `LiveDashboard` | packages/telegram-bot/index.ts | 532 |
| other | `UnifiedPortal` | packages/telegram-bot/index.ts | 533 |
| other | `formatForTelegram` | packages/telegram-bot/index.ts | 533 |
| function | `formatScoreboard` | packages/telegram-bot/formatters.ts | 141 |
| function | `formatCompetitionRound` | packages/telegram-bot/formatters.ts | 172 |
| function | `formatBenchmarkReport` | packages/telegram-bot/formatters.ts | 226 |
| function | `formatMorningBrief` | packages/telegram-bot/formatters.ts | 290 |
| function | `formatTierBreakdown` | packages/telegram-bot/formatters.ts | 362 |
| function | `formatMutationList` | packages/telegram-bot/formatters.ts | 398 |
| function | `formatAlert` | packages/telegram-bot/formatters.ts | 418 |
| function | `formatSystemStatus` | packages/telegram-bot/formatters.ts | 437 |
| function | `formatComparison` | packages/telegram-bot/formatters.ts | 468 |
| other | `trendArrow` | packages/telegram-bot/formatters.ts | 530 |

### packages/ai (40)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `EightAgentConfig` | packages/ai/agent.ts | 17 |
| other | `StepFinishEvent` | packages/ai/agent.ts | 38 |
| other | `ToolCallStartEvent` | packages/ai/agent.ts | 90 |
| other | `ToolCallFinishEvent` | packages/ai/agent.ts | 97 |
| other | `FinishEvent` | packages/ai/agent.ts | 108 |
| function | `createEightAgent` | packages/ai/agent.ts | 120 |
| function | `runAgent` | packages/ai/agent.ts | 281 |
| other | `RouteDecision` | packages/ai/task-router.ts | 30 |
| other | `ModelSlot` | packages/ai/task-router.ts | 37 |
| other | `RouterConfig` | packages/ai/task-router.ts | 43 |
| function | `loadRouterConfig` | packages/ai/task-router.ts | 84 |
| function | `saveRouterConfig` | packages/ai/task-router.ts | 94 |
| function | `recordRouting` | packages/ai/task-router.ts | 130 |
| class | `TaskRouter` | packages/ai/task-router.ts | 164 |
| function | `getRetryConfig` | packages/ai/providers.ts | 62 |
| function | `isProviderAvailable` | packages/ai/providers.ts | 81 |
| function | `registerToolsInToolshed` | packages/ai/toolshed-bridge.ts | 86 |
| class | `EmbeddingCache` | packages/ai/embedding-cache.ts | 18 |
| other | `ToolContext` | packages/ai/tools.ts | 17 |
| function | `getToolContext` | packages/ai/tools.ts | 27 |
| function | `embed` | packages/ai/edge-inference.ts | 27 |
| function | `batchEmbed` | packages/ai/edge-inference.ts | 55 |
| function | `similarity` | packages/ai/edge-inference.ts | 67 |
| function | `classify` | packages/ai/edge-inference.ts | 88 |
| function | `isEdgeInferenceAvailable` | packages/ai/edge-inference.ts | 120 |
| other | `isProviderAvailable` | packages/ai/index.ts | 16 |
| other | `getToolContext` | packages/ai/index.ts | 20 |
| other | `createEightAgent` | packages/ai/index.ts | 24 |
| other | `runAgent` | packages/ai/index.ts | 24 |
| other | `TaskRouter` | packages/ai/index.ts | 34 |
| other | `loadRouterConfig` | packages/ai/index.ts | 34 |
| other | `saveRouterConfig` | packages/ai/index.ts | 34 |
| other | `recordRouting` | packages/ai/index.ts | 34 |
| other | `registerToolsInToolshed` | packages/ai/index.ts | 38 |
| other | `embed` | packages/ai/index.ts | 41 |
| other | `batchEmbed` | packages/ai/index.ts | 41 |
| other | `similarity` | packages/ai/index.ts | 41 |
| other | `classify` | packages/ai/index.ts | 41 |
| other | `isEdgeInferenceAvailable` | packages/ai/index.ts | 41 |
| other | `EmbeddingCache` | packages/ai/index.ts | 42 |

### packages/hooks (39)

| Kind | Name | File | Line |
|------|------|------|------|
| const | `loggingHook` | packages/hooks/defaults.ts | 18 |
| const | `commandLoggingHook` | packages/hooks/defaults.ts | 32 |
| const | `errorLoggingHook` | packages/hooks/defaults.ts | 46 |
| const | `timingHook` | packages/hooks/defaults.ts | 63 |
| const | `macosNotificationHook` | packages/hooks/defaults.ts | 85 |
| const | `macosVoiceHook` | packages/hooks/defaults.ts | 99 |
| const | `terminalBellHook` | packages/hooks/defaults.ts | 113 |
| const | `telegramNotificationHook` | packages/hooks/defaults.ts | 126 |
| const | `autoGitAddHook` | packages/hooks/defaults.ts | 144 |
| const | `gitStatusAfterWriteHook` | packages/hooks/defaults.ts | 166 |
| const | `backupBeforeEditHook` | packages/hooks/defaults.ts | 183 |
| const | `commandValidationHook` | packages/hooks/defaults.ts | 209 |
| const | `sessionStartHook` | packages/hooks/defaults.ts | 236 |
| const | `sessionExitHook` | packages/hooks/defaults.ts | 249 |
| const | `autoLintHook` | packages/hooks/defaults.ts | 266 |
| const | `autoFormatHook` | packages/hooks/defaults.ts | 296 |
| const | `DEFAULT_HOOKS` | packages/hooks/defaults.ts | 314 |
| function | `registerDefaultHooks` | packages/hooks/defaults.ts | 349 |
| function | `enableDefaultHooks` | packages/hooks/defaults.ts | 364 |
| function | `setupLoggingHooks` | packages/hooks/defaults.ts | 379 |
| function | `setupNotificationHooks` | packages/hooks/defaults.ts | 383 |
| function | `setupGitHooks` | packages/hooks/defaults.ts | 387 |
| function | `setupSafetyHooks` | packages/hooks/defaults.ts | 391 |
| function | `setupDeveloperHooks` | packages/hooks/defaults.ts | 395 |
| other | `VoiceConfig` | packages/hooks/voice.ts | 21 |
| function | `configureVoice` | packages/hooks/voice.ts | 47 |
| function | `getVoiceConfig` | packages/hooks/voice.ts | 51 |
| function | `extractCompletionMessage` | packages/hooks/voice.ts | 62 |
| function | `speak` | packages/hooks/voice.ts | 86 |
| function | `voiceCompletionHook` | packages/hooks/voice.ts | 123 |
| function | `generateCompletionVoice` | packages/hooks/voice.ts | 150 |
| function | `setupVoiceHook` | packages/hooks/voice.ts | 213 |
| function | `testVoice` | packages/hooks/voice.ts | 234 |
| type | `HookType` | packages/hooks/index.ts | 17 |
| other | `HooksConfig` | packages/hooks/index.ts | 79 |
| other | `HookResult` | packages/hooks/index.ts | 86 |
| function | `resetHookManager` | packages/hooks/index.ts | 542 |
| function | `executeHooks` | packages/hooks/index.ts | 554 |
| function | `registerScriptHook` | packages/hooks/index.ts | 580 |

### packages/self-autonomy (39)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `getDb` | packages/self-autonomy/evolution-db.ts | 48 |
| function | `getReflection` | packages/self-autonomy/evolution-db.ts | 98 |
| function | `getRecentReflections` | packages/self-autonomy/evolution-db.ts | 105 |
| function | `saveSkill` | packages/self-autonomy/evolution-db.ts | 127 |
| function | `getSkillById` | packages/self-autonomy/evolution-db.ts | 136 |
| function | `getAllSkills` | packages/self-autonomy/evolution-db.ts | 142 |
| function | `querySkillsByTrigger` | packages/self-autonomy/evolution-db.ts | 148 |
| function | `updateSkillStats` | packages/self-autonomy/evolution-db.ts | 156 |
| other | `HeartbeatConfig` | packages/self-autonomy/heartbeat.ts | 15 |
| other | `HeartbeatStatus` | packages/self-autonomy/heartbeat.ts | 30 |
| type | `HeartbeatEvent` | packages/self-autonomy/heartbeat.ts | 55 |
| function | `resetHeartbeatAgents` | packages/self-autonomy/heartbeat.ts | 427 |
| other | `PersonaParameter` | packages/self-autonomy/persona-mutation.ts | 18 |
| class | `PersonaMutator` | packages/self-autonomy/persona-mutation.ts | 53 |
| other | `SessionData` | packages/self-autonomy/reflection.ts | 15 |
| function | `reflect` | packages/self-autonomy/reflection.ts | 37 |
| type | `OnboardingStep` | packages/self-autonomy/onboarding.ts | 89 |
| type | `CommunicationStyle` | packages/self-autonomy/onboarding.ts | 102 |
| other | `OnboardingQuestion` | packages/self-autonomy/onboarding.ts | 108 |
| other | `AutoDetected` | packages/self-autonomy/onboarding.ts | 116 |
| other | `SelfAutonomyConfig` | packages/self-autonomy/index.ts | 16 |
| other | `GitState` | packages/self-autonomy/index.ts | 24 |
| other | `HealingPattern` | packages/self-autonomy/index.ts | 31 |
| other | `HealingMemory` | packages/self-autonomy/index.ts | 38 |
| other | `WorkingContext` | packages/self-autonomy/index.ts | 42 |
| other | `EvolutionEntry` | packages/self-autonomy/index.ts | 53 |
| function | `createSelfAutonomy` | packages/self-autonomy/index.ts | 658 |
| other | `OnboardingStep` | packages/self-autonomy/index.ts | 663 |
| other | `reflect` | packages/self-autonomy/index.ts | 666 |
| other | `SessionData` | packages/self-autonomy/index.ts | 666 |
| other | `learnSkill` | packages/self-autonomy/index.ts | 667 |
| other | `getRelevantSkills` | packages/self-autonomy/index.ts | 667 |
| other | `reinforceSkill` | packages/self-autonomy/index.ts | 667 |
| other | `buildSkillsContext` | packages/self-autonomy/index.ts | 667 |
| class | `PreferencesSyncManager` | packages/self-autonomy/preferences-sync.ts | 26 |
| function | `learnSkill` | packages/self-autonomy/learned-skills.ts | 28 |
| function | `getRelevantSkills` | packages/self-autonomy/learned-skills.ts | 62 |
| function | `reinforceSkill` | packages/self-autonomy/learned-skills.ts | 93 |
| function | `buildSkillsContext` | packages/self-autonomy/learned-skills.ts | 101 |

### packages/validation (38)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `StepReport` | packages/validation/report.ts | 32 |
| other | `ReportDisplayOptions` | packages/validation/report.ts | 44 |
| class | `ValidationReporter` | packages/validation/report.ts | 56 |
| function | `getValidationReporter` | packages/validation/report.ts | 522 |
| other | `EvidenceCollectorConfig` | packages/validation/evidence.ts | 52 |
| other | `StepExecutionResult` | packages/validation/evidence.ts | 59 |
| function | `formatEvidence` | packages/validation/evidence.ts | 491 |
| function | `filterEvidence` | packages/validation/evidence.ts | 551 |
| function | `isEvidenceSufficient` | packages/validation/evidence.ts | 558 |
| other | `SecretPattern` | packages/validation/secret-patterns.ts | 8 |
| other | `VulnerabilityPattern` | packages/validation/secret-patterns.ts | 79 |
| const | `ABILITIES` | packages/validation/ability-scorecard.ts | 18 |
| type | `AbilityName` | packages/validation/ability-scorecard.ts | 29 |
| other | `AbilityScorecard` | packages/validation/ability-scorecard.ts | 32 |
| other | `AbilityMetric` | packages/validation/ability-scorecard.ts | 44 |
| other | `BaselineDelta` | packages/validation/ability-scorecard.ts | 52 |
| const | `ABILITY_METRIC_DESCRIPTIONS` | packages/validation/ability-scorecard.ts | 63 |
| other | `SecurityFinding` | packages/validation/security-scanner.ts | 18 |
| other | `ScanOptions` | packages/validation/security-scanner.ts | 28 |
| function | `scanContent` | packages/validation/security-scanner.ts | 62 |
| function | `scanFile` | packages/validation/security-scanner.ts | 116 |
| function | `scanDirectory` | packages/validation/security-scanner.ts | 128 |
| other | `ScanSummary` | packages/validation/security-scanner.ts | 174 |
| function | `summarizeFindings` | packages/validation/security-scanner.ts | 183 |
| function | `hasCriticalFindings` | packages/validation/security-scanner.ts | 206 |
| other | `UnusedExport` | packages/validation/dead-code-finder.ts | 15 |
| other | `DeadCodeReport` | packages/validation/dead-code-finder.ts | 22 |
| function | `findDeadCode` | packages/validation/dead-code-finder.ts | 104 |
| other | `VerifyCheck` | packages/validation/healing.ts | 28 |
| other | `VerifyResult` | packages/validation/healing.ts | 35 |
| other | `HealingResult` | packages/validation/healing.ts | 40 |
| other | `SelfHealerOptions` | packages/validation/healing.ts | 47 |
| class | `SelfHealer` | packages/validation/healing.ts | 56 |
| other | `Checkpoint` | packages/validation/checkpoint.ts | 10 |
| function | `createCheckpoint` | packages/validation/checkpoint.ts | 30 |
| function | `restoreCheckpoint` | packages/validation/checkpoint.ts | 63 |
| function | `dropCheckpoint` | packages/validation/checkpoint.ts | 82 |
| function | `readFailures` | packages/validation/failure-log.ts | 42 |

### packages/specifications (36)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `SessionListItem` | packages/specifications/session/reader.ts | 27 |
| class | `SessionReader` | packages/specifications/session/reader.ts | 207 |
| function | `normalizeToV1` | packages/specifications/session/reader.ts | 307 |
| other | `SessionMeta` | packages/specifications/session/index.ts | 53 |
| type | `FinishReason` | packages/specifications/session/index.ts | 76 |
| other | `ModelInfo` | packages/specifications/session/index.ts | 88 |
| other | `ResponseMeta` | packages/specifications/session/index.ts | 137 |
| other | `TextPart` | packages/specifications/session/index.ts | 152 |
| other | `ReasoningPart` | packages/specifications/session/index.ts | 157 |
| other | `SourcePart` | packages/specifications/session/index.ts | 164 |
| other | `FilePart` | packages/specifications/session/index.ts | 173 |
| other | `ToolCallPart` | packages/specifications/session/index.ts | 181 |
| other | `ToolResultPart` | packages/specifications/session/index.ts | 188 |
| other | `ToolErrorPart` | packages/specifications/session/index.ts | 195 |
| other | `ToolCall` | packages/specifications/session/index.ts | 215 |
| other | `HookExecution` | packages/specifications/session/index.ts | 238 |
| other | `SessionError` | packages/specifications/session/index.ts | 246 |
| other | `SessionSummary` | packages/specifications/session/index.ts | 254 |
| other | `SessionStartEntry` | packages/specifications/session/index.ts | 284 |
| other | `UserMessageEntry` | packages/specifications/session/index.ts | 289 |
| other | `AssistantContentEntry` | packages/specifications/session/index.ts | 295 |
| other | `StepStartEntry` | packages/specifications/session/index.ts | 306 |
| other | `StepEndEntry` | packages/specifications/session/index.ts | 317 |
| other | `ToolErrorEntry` | packages/specifications/session/index.ts | 332 |
| other | `AssistantMessageEntry` | packages/specifications/session/index.ts | 344 |
| other | `ToolCallEntry` | packages/specifications/session/index.ts | 352 |
| other | `ToolResultEntry` | packages/specifications/session/index.ts | 360 |
| other | `TurnStartEntry` | packages/specifications/session/index.ts | 372 |
| other | `TurnEndEntry` | packages/specifications/session/index.ts | 378 |
| other | `HookEntry` | packages/specifications/session/index.ts | 385 |
| other | `ErrorEntry` | packages/specifications/session/index.ts | 390 |
| other | `SessionEndEntry` | packages/specifications/session/index.ts | 395 |
| type | `SessionEntryType` | packages/specifications/session/index.ts | 423 |
| other | `SessionReader` | packages/specifications/session/index.ts | 430 |
| other | `SessionListItem` | packages/specifications/session/index.ts | 430 |
| const | `SESSIONS_DIR` | packages/specifications/session/index.ts | 433 |

### benchmarks/autoresearch (31)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `extractCode` | benchmarks/autoresearch/execution-grader.ts | 26 |
| other | `ExtractedFile` | benchmarks/autoresearch/execution-grader.ts | 60 |
| function | `extractMultiFileCode` | benchmarks/autoresearch/execution-grader.ts | 75 |
| function | `gradeKeywords` | benchmarks/autoresearch/execution-grader.ts | 131 |
| function | `gradeExecution` | benchmarks/autoresearch/execution-grader.ts | 161 |
| function | `gradeMultiFileExecution` | benchmarks/autoresearch/execution-grader.ts | 233 |
| const | `BASE_SYSTEM_PROMPT` | benchmarks/autoresearch/system-prompt.ts | 8 |
| function | `getMutationCount` | benchmarks/autoresearch/system-prompt.ts | 104 |
| other | `GradingWeights` | benchmarks/autoresearch/meta-optimizer.ts | 15 |
| other | `MetaConfig` | benchmarks/autoresearch/meta-optimizer.ts | 20 |
| class | `MetaOptimizer` | benchmarks/autoresearch/meta-optimizer.ts | 74 |
| other | `runAutoresearchLoop` | benchmarks/autoresearch/harness.ts | 460 |
| other | `runBenchmarkOn8gent` | benchmarks/autoresearch/harness.ts | 460 |
| other | `gradeSolution` | benchmarks/autoresearch/harness.ts | 460 |
| other | `Todo` | benchmarks/autoresearch/few-shot.ts | 126 |
| function | `registerRoutes` | benchmarks/autoresearch/few-shot.ts | 139 |
| function | `createApp` | benchmarks/autoresearch/few-shot.ts | 158 |
| type | `Role` | benchmarks/autoresearch/few-shot.ts | 287 |
| function | `hashPassword` | benchmarks/autoresearch/few-shot.ts | 289 |
| function | `verifyPassword` | benchmarks/autoresearch/few-shot.ts | 295 |
| function | `generateToken` | benchmarks/autoresearch/few-shot.ts | 301 |
| function | `verifyToken` | benchmarks/autoresearch/few-shot.ts | 314 |
| function | `generateRefreshToken` | benchmarks/autoresearch/few-shot.ts | 323 |
| function | `generateResetCode` | benchmarks/autoresearch/few-shot.ts | 324 |
| type | `Role` | benchmarks/autoresearch/few-shot.ts | 328 |
| function | `hasPermission` | benchmarks/autoresearch/few-shot.ts | 338 |
| function | `listFewShotCategories` | benchmarks/autoresearch/few-shot.ts | 357 |
| function | `updateCounter` | benchmarks/autoresearch/baseline-solutions/BF001-claude-solution.ts | 15 |
| function | `getCounter` | benchmarks/autoresearch/baseline-solutions/BF001-claude-solution.ts | 46 |
| function | `resetCounter` | benchmarks/autoresearch/baseline-solutions/BF001-claude-solution.ts | 50 |
| function | `demonstrateFix` | benchmarks/autoresearch/baseline-solutions/BF001-claude-solution.ts | 55 |

### packages/design-agent (28)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `DesignPromptContext` | packages/design-agent/prompts.ts | 13 |
| const | `DESIGN_INTROS` | packages/design-agent/prompts.ts | 51 |
| function | `getDesignIntro` | packages/design-agent/prompts.ts | 64 |
| const | `OPTION_TEMPLATES` | packages/design-agent/prompts.ts | 107 |
| function | `formatDesignOptions` | packages/design-agent/prompts.ts | 121 |
| const | `FOLLOW_UP_PROMPTS` | packages/design-agent/prompts.ts | 149 |
| const | `DESIGN_ANALYSIS_SYSTEM_PROMPT` | packages/design-agent/prompts.ts | 170 |
| function | `generateAnalysisPrompt` | packages/design-agent/prompts.ts | 186 |
| const | `QUICK_SUGGESTIONS` | packages/design-agent/prompts.ts | 227 |
| other | `DesignSuggestion` | packages/design-agent/suggester.ts | 27 |
| other | `DesignPreview` | packages/design-agent/suggester.ts | 40 |
| other | `SuggesterConfig` | packages/design-agent/suggester.ts | 45 |
| other | `SuggestionResult` | packages/design-agent/suggester.ts | 56 |
| class | `DesignSuggester` | packages/design-agent/suggester.ts | 313 |
| function | `createSuggester` | packages/design-agent/suggester.ts | 577 |
| function | `suggestDesignSystems` | packages/design-agent/suggester.ts | 584 |
| function | `getAvailableDesignSystems` | packages/design-agent/suggester.ts | 595 |
| other | `DesignAgentConfig` | packages/design-agent/index.ts | 55 |
| other | `DesignAgentState` | packages/design-agent/index.ts | 70 |
| other | `DesignAvenue` | packages/design-agent/index.ts | 79 |
| class | `DesignAgent` | packages/design-agent/index.ts | 92 |
| function | `interceptForDesign` | packages/design-agent/index.ts | 405 |
| function | `createDesignAgent` | packages/design-agent/index.ts | 442 |
| other | `DetectorConfig` | packages/design-agent/detector.ts | 45 |
| class | `DesignDecisionDetector` | packages/design-agent/detector.ts | 191 |
| function | `createDetector` | packages/design-agent/detector.ts | 537 |
| function | `detectDesignNeed` | packages/design-agent/detector.ts | 544 |
| function | `needsDesignDecision` | packages/design-agent/detector.ts | 552 |

### packages/skills (22)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `Skill` | packages/skills/index.ts | 29 |
| other | `SkillFrontmatter` | packages/skills/index.ts | 39 |
| other | `SkillInvocation` | packages/skills/index.ts | 47 |
| class | `SkillManager` | packages/skills/index.ts | 117 |
| function | `getSkillManager` | packages/skills/index.ts | 371 |
| function | `resetSkillManager` | packages/skills/index.ts | 378 |
| function | `parseSkillCommand` | packages/skills/index.ts | 390 |
| function | `buildBusiness` | packages/skills/business-builder/orchestrator.ts | 134 |
| other | `AgentDef` | packages/skills/business-builder/agents.ts | 5 |
| const | `AGENT_DEFS` | packages/skills/business-builder/agents.ts | 14 |
| type | `BuildDepth` | packages/skills/business-builder/types.ts | 3 |
| other | `buildBusiness` | packages/skills/business-builder/index.ts | 6 |
| other | `AGENT_DEFS` | packages/skills/business-builder/index.ts | 7 |
| class | `QuestioningEngine` | packages/skills/business-builder/src/modules/questioning.ts | 3 |
| const | `questioningEngine` | packages/skills/business-builder/src/modules/questioning.ts | 147 |
| class | `MarketResearchModule` | packages/skills/business-builder/src/modules/market-research.ts | 4 |
| type | `BusinessType` | packages/skills/business-builder/src/types/index.ts | 1 |
| other | `Competitor` | packages/skills/business-builder/src/types/index.ts | 47 |
| class | `JBTD` | packages/skills/business-builder/src/types/index.ts | 60 |
| class | `BrandVision` | packages/skills/business-builder/src/types/index.ts | 125 |
| other | `BrandPositioning` | packages/skills/business-builder/src/types/index.ts | 169 |
| type | `MessageResponse` | packages/skills/business-builder/src/types/index.ts | 186 |

### packages/ast-index (22)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `DepNode` | packages/ast-index/dep-graph.ts | 11 |
| other | `BlastRadius` | packages/ast-index/blast-radius.ts | 14 |
| function | `invalidateGraphCache` | packages/ast-index/blast-radius.ts | 35 |
| function | `getBlastRadius` | packages/ast-index/blast-radius.ts | 61 |
| other | `buildDepGraph` | packages/ast-index/blast-radius.ts | 94 |
| other | `DepGraph` | packages/ast-index/blast-radius.ts | 94 |
| other | `findTestsFor` | packages/ast-index/blast-radius.ts | 95 |
| other | `buildTestMap` | packages/ast-index/blast-radius.ts | 95 |
| function | `searchInFile` | packages/ast-index/typescript-parser.ts | 256 |
| function | `buildTestMap` | packages/ast-index/test-map.ts | 52 |
| other | `Parser` | packages/ast-index/index.ts | 16 |
| other | `ParsedFile` | packages/ast-index/index.ts | 21 |
| other | `ParsedSymbol` | packages/ast-index/index.ts | 27 |
| function | `indexRepo` | packages/ast-index/index.ts | 120 |
| function | `getFileOutline` | packages/ast-index/index.ts | 133 |
| function | `getSymbol` | packages/ast-index/index.ts | 142 |
| function | `searchSymbols` | packages/ast-index/index.ts | 173 |
| function | `getFileTree` | packages/ast-index/index.ts | 213 |
| function | `listRepos` | packages/ast-index/index.ts | 232 |
| function | `getRepoStats` | packages/ast-index/index.ts | 239 |
| function | `clearIndex` | packages/ast-index/index.ts | 246 |
| function | `estimateTokenSavings` | packages/ast-index/index.ts | 261 |

### packages/daemon (20)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `getDataSubDir` | packages/daemon/data-dir.ts | 34 |
| type | `TaskPriority` | packages/daemon/task-registry.ts | 16 |
| other | `CEOTask` | packages/daemon/task-registry.ts | 18 |
| function | `createTask` | packages/daemon/task-registry.ts | 66 |
| function | `updateTask` | packages/daemon/task-registry.ts | 82 |
| function | `getTask` | packages/daemon/task-registry.ts | 91 |
| function | `listTasks` | packages/daemon/task-registry.ts | 96 |
| function | `getTasksByStatus` | packages/daemon/task-registry.ts | 101 |
| function | `getActiveTasks` | packages/daemon/task-registry.ts | 106 |
| other | `HeartbeatConfig` | packages/daemon/heartbeat.ts | 12 |
| other | `HeartbeatResult` | packages/daemon/heartbeat.ts | 24 |
| type | `NotificationType` | packages/daemon/notifications.ts | 10 |
| class | `CoSRouter` | packages/daemon/cos-router.ts | 41 |
| other | `PoolConfig` | packages/daemon/agent-pool.ts | 12 |
| function | `loadJobs` | packages/daemon/cron.ts | 28 |
| other | `DaemonEvents` | packages/daemon/events.ts | 8 |
| type | `EventPayload` | packages/daemon/events.ts | 27 |
| type | `EventHandler` | packages/daemon/events.ts | 28 |
| class | `EventBus` | packages/daemon/events.ts | 38 |
| other | `GatewayConfig` | packages/daemon/gateway.ts | 12 |

### packages/permissions (20)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `detectBestIsolation` | packages/permissions/sandbox.ts | 56 |
| function | `runSandboxed` | packages/permissions/sandbox.ts | 223 |
| other | `PermissionConfig` | packages/permissions/index.ts | 17 |
| other | `PermissionRequest` | packages/permissions/index.ts | 26 |
| other | `PermissionLog` | packages/permissions/index.ts | 36 |
| other | `InfiniteModeAuditEntry` | packages/permissions/index.ts | 43 |
| const | `ALWAYS_BLOCKED_COMMANDS` | packages/permissions/index.ts | 65 |
| const | `DANGEROUS_COMMAND_RULES` | packages/permissions/index.ts | 86 |
| const | `HEADLESS_SAFE_COMMANDS` | packages/permissions/index.ts | 157 |
| const | `DANGEROUS_COMMANDS` | packages/permissions/index.ts | 206 |
| const | `SAFE_PATTERNS` | packages/permissions/index.ts | 223 |
| function | `parseCommand` | packages/permissions/index.ts | 270 |
| class | `PermissionManager` | packages/permissions/index.ts | 331 |
| function | `resetPermissionManager` | packages/permissions/index.ts | 956 |
| function | `needsPermission` | packages/permissions/index.ts | 968 |
| function | `requestCommandPermission` | packages/permissions/index.ts | 976 |
| function | `isCommandDangerous` | packages/permissions/index.ts | 993 |
| function | `isInfiniteMode` | packages/permissions/index.ts | 1018 |
| function | `addPolicy` | packages/permissions/policy-engine.ts | 207 |
| function | `getPolicies` | packages/permissions/policy-engine.ts | 219 |

### packages/kernel (19)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `KernelConfig` | packages/kernel/manager.ts | 15 |
| other | `LocalTrainerConfig` | packages/kernel/local-trainer.ts | 26 |
| class | `LocalTrainer` | packages/kernel/local-trainer.ts | 129 |
| function | `checkTrainerDeps` | packages/kernel/local-trainer.ts | 594 |
| other | `KernelConfig` | packages/kernel/index.ts | 15 |
| other | `LocalTrainer` | packages/kernel/index.ts | 16 |
| other | `checkTrainerDeps` | packages/kernel/index.ts | 16 |
| other | `LocalTrainerConfig` | packages/kernel/index.ts | 16 |
| other | `ModelVersion` | packages/kernel/version-manager.ts | 20 |
| other | `VersionEntry` | packages/kernel/version-manager.ts | 32 |
| other | `BenchmarkBaseline` | packages/kernel/version-manager.ts | 41 |
| function | `getCurrentVersion` | packages/kernel/version-manager.ts | 53 |
| function | `getVersionString` | packages/kernel/version-manager.ts | 74 |
| function | `saveVersion` | packages/kernel/version-manager.ts | 79 |
| function | `getBaseline` | packages/kernel/version-manager.ts | 89 |
| function | `saveBaseline` | packages/kernel/version-manager.ts | 98 |
| function | `judgeImprovement` | packages/kernel/version-manager.ts | 106 |
| function | `checkPersonalLoraCompatibility` | packages/kernel/version-manager.ts | 192 |
| function | `evaluateAndBump` | packages/kernel/version-manager.ts | 206 |

### apps/clui (18)

| Kind | Name | File | Line |
|------|------|------|------|
| type | `StepCategory` | apps/clui/src/components/PlanKanban.tsx | 23 |
| other | `PlanStep` | apps/clui/src/components/PlanKanban.tsx | 33 |
| other | `PlanKanbanProps` | apps/clui/src/components/PlanKanban.tsx | 43 |
| other | `EvidencePanelProps` | apps/clui/src/components/EvidencePanel.tsx | 49 |
| type | `ThemeMode` | apps/clui/src/stores/preferences-store.ts | 14 |
| type | `ModelProvider` | apps/clui/src/stores/preferences-store.ts | 16 |
| other | `ModelConfig` | apps/clui/src/stores/preferences-store.ts | 18 |
| other | `UsageStats` | apps/clui/src/stores/preferences-store.ts | 26 |
| other | `PreferencesStore` | apps/clui/src/stores/preferences-store.ts | 34 |
| type | `AuthStateName` | apps/clui/src/stores/auth-store.ts | 28 |
| other | `DeviceCodeInfo` | apps/clui/src/stores/auth-store.ts | 36 |
| other | `AuthStore` | apps/clui/src/stores/auth-store.ts | 41 |
| type | `MessageRole` | apps/clui/src/stores/session-store.ts | 15 |
| type | `SessionStatus` | apps/clui/src/stores/session-store.ts | 29 |
| type | `ProcessingStage` | apps/clui/src/stores/session-store.ts | 31 |
| other | `ToolCall` | apps/clui/src/stores/session-store.ts | 33 |
| other | `SessionState` | apps/clui/src/stores/session-store.ts | 43 |
| other | `SessionStore` | apps/clui/src/stores/session-store.ts | 62 |

### packages/toolshed (18)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `SkillSummary` | packages/toolshed/skill-registry.ts | 23 |
| other | `SkillQuery` | packages/toolshed/skill-registry.ts | 31 |
| class | `SkillRegistry` | packages/toolshed/skill-registry.ts | 42 |
| function | `resetSkillRegistry` | packages/toolshed/skill-registry.ts | 311 |
| other | `ToolSummary` | packages/toolshed/registry/discovery.ts | 10 |
| other | `DiscoveryQuery` | packages/toolshed/registry/discovery.ts | 17 |
| function | `listToolsByCapability` | packages/toolshed/registry/discovery.ts | 26 |
| function | `listToolsByPermission` | packages/toolshed/registry/discovery.ts | 35 |
| function | `searchTools` | packages/toolshed/registry/discovery.ts | 44 |
| function | `queryTools` | packages/toolshed/registry/discovery.ts | 54 |
| function | `getToolDetails` | packages/toolshed/registry/discovery.ts | 76 |
| function | `listCapabilities` | packages/toolshed/registry/discovery.ts | 83 |
| function | `formatForAgent` | packages/toolshed/registry/discovery.ts | 108 |
| function | `resetToolRegistry` | packages/toolshed/registry/index.ts | 273 |
| function | `unregisterTool` | packages/toolshed/registry/register.ts | 37 |
| function | `hasTool` | packages/toolshed/registry/register.ts | 61 |
| function | `getToolCount` | packages/toolshed/registry/register.ts | 75 |
| function | `clearRegistry` | packages/toolshed/registry/register.ts | 82 |

### packages/planning (14)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `ProactiveStep` | packages/planning/proactive-planner.ts | 32 |
| type | `StepCategory` | packages/planning/proactive-planner.ts | 44 |
| other | `KanbanBoard` | packages/planning/proactive-planner.ts | 58 |
| other | `PredictionContext` | packages/planning/proactive-planner.ts | 65 |
| function | `resetProactivePlanner` | packages/planning/proactive-planner.ts | 655 |
| other | `Avenue` | packages/planning/avenue-tracker.ts | 18 |
| type | `AvenueCategory` | packages/planning/avenue-tracker.ts | 31 |
| other | `PreGeneratedPlan` | packages/planning/avenue-tracker.ts | 41 |
| other | `PreGeneratedStep` | packages/planning/avenue-tracker.ts | 48 |
| other | `AvenueContext` | packages/planning/avenue-tracker.ts | 57 |
| other | `UserPattern` | packages/planning/avenue-tracker.ts | 72 |
| class | `AvenueTracker` | packages/planning/avenue-tracker.ts | 82 |
| function | `getAvenueTracker` | packages/planning/avenue-tracker.ts | 781 |
| function | `resetAvenueTracker` | packages/planning/avenue-tracker.ts | 788 |

### packages/providers (12)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `ChatMessage` | packages/providers/index.ts | 52 |
| other | `ToolCall` | packages/providers/index.ts | 59 |
| other | `ChatRequest` | packages/providers/index.ts | 65 |
| other | `ToolDefinition` | packages/providers/index.ts | 74 |
| other | `ChatResponse` | packages/providers/index.ts | 83 |
| other | `ProviderSettings` | packages/providers/index.ts | 95 |
| class | `ProviderManager` | packages/providers/index.ts | 271 |
| function | `getBestFreeModel` | packages/providers/index.ts | 644 |
| function | `resolveModel` | packages/providers/index.ts | 705 |
| function | `getProviderManager` | packages/providers/index.ts | 719 |
| function | `resetProviderManager` | packages/providers/index.ts | 726 |
| const | `PROVIDER_NAMES` | packages/providers/index.ts | 731 |

### apps/debugger (11)

| Kind | Name | File | Line |
|------|------|------|------|
| const | `metadata` | apps/debugger/app/layout.tsx | 10 |
| const | `metadata` | apps/debugger/app/presentation/page.tsx | 4 |
| const | `dynamic` | apps/debugger/app/api/system-health/route.ts | 7 |
| function | `GET` | apps/debugger/app/api/system-health/route.ts | 207 |
| const | `dynamic` | apps/debugger/app/api/sessions/route.ts | 7 |
| function | `GET` | apps/debugger/app/api/sessions/route.ts | 119 |
| const | `dynamic` | apps/debugger/app/api/sessions/[id]/route.ts | 6 |
| function | `GET` | apps/debugger/app/api/sessions/[id]/route.ts | 10 |
| const | `dynamic` | apps/debugger/app/api/sessions/[id]/stream/route.ts | 7 |
| const | `runtime` | apps/debugger/app/api/sessions/[id]/stream/route.ts | 8 |
| function | `GET` | apps/debugger/app/api/sessions/[id]/stream/route.ts | 12 |

### packages/registry (11)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `getDatabase` | packages/registry/index.ts | 43 |
| other | `Primitive` | packages/registry/index.ts | 54 |
| function | `addPrimitive` | packages/registry/index.ts | 68 |
| function | `getPrimitive` | packages/registry/index.ts | 91 |
| function | `searchPrimitives` | packages/registry/index.ts | 98 |
| function | `listPrimitivesByType` | packages/registry/index.ts | 130 |
| function | `startSession` | packages/registry/index.ts | 156 |
| function | `endSession` | packages/registry/index.ts | 168 |
| function | `recordCommand` | packages/registry/index.ts | 175 |
| function | `getSessionStats` | packages/registry/index.ts | 198 |
| function | `getTotalStats` | packages/registry/index.ts | 216 |

### packages/types (10)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `JSONSchema` | packages/types/index.ts | 33 |
| other | `SandboxConfig` | packages/types/index.ts | 71 |
| other | `Plan` | packages/types/index.ts | 135 |
| other | `WorkflowStep` | packages/types/index.ts | 147 |
| other | `Workflow` | packages/types/index.ts | 156 |
| other | `Primitive` | packages/types/index.ts | 168 |
| other | `PrimitiveRegistry` | packages/types/index.ts | 178 |
| other | `GitHubSymbol` | packages/types/index.ts | 188 |
| other | `GitHubQuery` | packages/types/index.ts | 194 |
| other | `DependencyGraph` | packages/types/index.ts | 201 |

### benchmarks/categories (10)

| Kind | Name | File | Line |
|------|------|------|------|
| const | `ABILITY_SHOWCASE_BENCHMARK` | benchmarks/categories/ability-showcase/benchmark.ts | 16 |
| const | `benchmark` | benchmarks/categories/abilities/worktree-delegation.ts | 6 |
| function | `transform` | benchmarks/categories/agentic/benchmarks.ts | 155 |
| const | `systemsDebuggingBenchmark` | benchmarks/categories/bug-fixing/sd001.ts | 3 |
| other | `Subscription` | benchmarks/categories/bug-fixing/sd001.ts | 59 |
| type | `MessageHandler` | benchmarks/categories/bug-fixing/sd001.ts | 67 |
| other | `Topic` | benchmarks/categories/bug-fixing/sd001.ts | 69 |
| other | `BrokerOptions` | benchmarks/categories/bug-fixing/sd001.ts | 76 |
| type | `LifecycleHook` | benchmarks/categories/bug-fixing/sd001.ts | 105 |
| class | `MessageBroker` | benchmarks/categories/bug-fixing/sd001.ts | 107 |

### packages/mcp (9)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `MCPServerConfig` | packages/mcp/index.ts | 17 |
| other | `MCPConfig` | packages/mcp/index.ts | 24 |
| other | `MCPTool` | packages/mcp/index.ts | 28 |
| other | `MCPToolCall` | packages/mcp/index.ts | 38 |
| other | `MCPToolResult` | packages/mcp/index.ts | 43 |
| class | `MCPClient` | packages/mcp/index.ts | 75 |
| function | `resetMCPClient` | packages/mcp/index.ts | 429 |
| function | `loadMCPConfig` | packages/mcp/index.ts | 443 |
| function | `formatToolResult` | packages/mcp/index.ts | 451 |

### packages/tasks (9)

| Kind | Name | File | Line |
|------|------|------|------|
| type | `TaskPriority` | packages/tasks/index.ts | 28 |
| other | `TaskStore` | packages/tasks/index.ts | 52 |
| other | `TaskFilter` | packages/tasks/index.ts | 59 |
| other | `TaskUpdate` | packages/tasks/index.ts | 69 |
| class | `TaskManager` | packages/tasks/index.ts | 86 |
| function | `getTaskManager` | packages/tasks/index.ts | 652 |
| function | `resetTaskManager` | packages/tasks/index.ts | 659 |
| function | `formatTask` | packages/tasks/index.ts | 670 |
| function | `parseTaskCommand` | packages/tasks/index.ts | 720 |

### packages/quarantine (8)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `toToolshedEntry` | packages/quarantine/abstractor.ts | 338 |
| function | `toDetailedEntry` | packages/quarantine/abstractor.ts | 345 |
| other | `QuarantineEntry` | packages/quarantine/index.ts | 28 |
| other | `QuarantineConfig` | packages/quarantine/index.ts | 41 |
| class | `QuarantineManager` | packages/quarantine/index.ts | 52 |
| function | `resetQuarantineManager` | packages/quarantine/index.ts | 473 |
| type | `Severity` | packages/quarantine/scanner/security-scanner.ts | 16 |
| other | `Finding` | packages/quarantine/scanner/security-scanner.ts | 19 |

### packages/planner (7)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `PlanStep` | packages/planner/index.ts | 14 |
| other | `ExecutionPlan` | packages/planner/index.ts | 26 |
| other | `PlanningContext` | packages/planner/index.ts | 39 |
| other | `PlannerOptions` | packages/planner/index.ts | 46 |
| class | `Planner` | packages/planner/index.ts | 55 |
| function | `getPlanner` | packages/planner/index.ts | 454 |
| function | `resetPlanner` | packages/planner/index.ts | 461 |

### packages/i18n (6)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `LanguageConfig` | packages/i18n/index.ts | 16 |
| other | `I18nSettings` | packages/i18n/index.ts | 23 |
| const | `LANGUAGES` | packages/i18n/index.ts | 32 |
| class | `LanguageManager` | packages/i18n/index.ts | 225 |
| function | `getLanguageManager` | packages/i18n/index.ts | 305 |
| function | `resetLanguageManager` | packages/i18n/index.ts | 312 |

### packages/lsp (5)

| Kind | Name | File | Line |
|------|------|------|------|
| class | `LSPClient` | packages/lsp/index.ts | 143 |
| function | `lspGoToDefinition` | packages/lsp/index.ts | 644 |
| function | `lspFindReferences` | packages/lsp/index.ts | 676 |
| function | `lspHover` | packages/lsp/index.ts | 709 |
| function | `lspDocumentSymbols` | packages/lsp/index.ts | 735 |

### benchmarks/types.ts (5)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `ExecutionGradeResult` | benchmarks/types.ts | 36 |
| other | `KeywordGradeResult` | benchmarks/types.ts | 55 |
| other | `HarnessConfig` | benchmarks/types.ts | 95 |
| other | `PromptMutation` | benchmarks/types.ts | 116 |
| other | `SystemPromptState` | benchmarks/types.ts | 128 |

### packages/infinite (4)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `InfiniteConfig` | packages/infinite/index.ts | 22 |
| other | `ErrorRecord` | packages/infinite/index.ts | 68 |
| type | `InfiniteEvent` | packages/infinite/index.ts | 75 |
| function | `runInfinite` | packages/infinite/index.ts | 417 |

### packages/music (4)

| Kind | Name | File | Line |
|------|------|------|------|
| class | `DJ` | packages/music/dj.ts | 123 |
| class | `MusicProducer` | packages/music/producer.ts | 23 |
| other | `MusicProducer` | packages/music/index.ts | 13 |
| other | `DJ` | packages/music/index.ts | 19 |

### packages/executor (3)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `TaskResult` | packages/executor/autonomous.ts | 37 |
| other | `ExecutionOptions` | packages/executor/sandbox.ts | 26 |
| function | `executeFunction` | packages/executor/sandbox.ts | 97 |

### benchmarks/index.ts (3)

| Kind | Name | File | Line |
|------|------|------|------|
| other | `createStandardRubric` | benchmarks/index.ts | 12 |
| const | `ALL_BENCHMARKS` | benchmarks/index.ts | 32 |
| const | `BENCHMARK_STATS` | benchmarks/index.ts | 43 |

### packages/pet (2)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `PetWidget` | packages/pet/PetWidget.tsx | 20 |
| function | `PetOverlay` | packages/pet/PetWidget.tsx | 61 |

### apps/demos (1)

| Kind | Name | File | Line |
|------|------|------|------|
| const | `DarkModeToggle` | apps/demos/src/scenes/FeatureShowcase.tsx | 110 |

### apps/dashboard (1)

| Kind | Name | File | Line |
|------|------|------|------|
| const | `metadata` | apps/dashboard/app/layout.tsx | 12 |

### packages/telegram (1)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `getSavedToken` | packages/telegram/index.ts | 831 |

### packages/secrets (1)

| Kind | Name | File | Line |
|------|------|------|------|
| class | `SecretVault` | packages/secrets/index.ts | 54 |

### scripts/model-shootout.ts (1)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `testCheckpoint` | scripts/model-shootout.ts | 32 |

### benchmarks/grader.ts (1)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `createStandardRubric` | benchmarks/grader.ts | 463 |

### benchmarks/runner.ts (1)

| Kind | Name | File | Line |
|------|------|------|------|
| function | `solution` | benchmarks/runner.ts | 263 |

## Next Steps

1. Review each section above. Dismiss known false positives (Next.js conventions, CLI bins).
2. For confirmed dead code, either delete or move behind a feature flag.
3. Re-run periodically: `bun run packages/validation/dead-code-finder.ts`