/**
 * 8gent Code - Component Exports
 *
 * All animated TUI components in one place.
 */

// Animated spinner and status indicators
export {
  AnimatedSpinner,
  StatusIndicator,
  StepIndicator,
} from "./animated-spinner.js";

// Typing and text animations
export {
  TypingText,
  StreamingText,
  WordByWord,
  CodeTyping,
} from "./typing-text.js";

// Logo and branding animations
export {
  PulseLogo,
  BigLogo,
  SpinningRing,
  AnimatedWordmark,
} from "./pulse-logo.js";

// Progress bars and visualizations
export {
  AnimatedProgressBar,
  TokenSavingsBar,
  Sparkline,
  WaveProgress,
} from "./progress-bar.js";

// Border animations
export {
  RainbowBorder,
  GradientBorder,
  PulsingBorder,
  DecoratedBox,
  AnimatedSeparator,
} from "./rainbow-border.js";

// Fade and transition effects
export {
  FadeIn,
  FadeOut,
  SlideIn,
  PopIn,
  Blink,
  CascadeFade,
  GlowText,
} from "./fade-transition.js";

// Sound effects
export {
  playSound,
  useSound,
  useCompletionSound,
  useErrorSound,
  soundManager,
  SoundEffect,
  playTypingSound,
} from "./sound-effects.js";

// Core components
export { Header, CompactHeader, FancyHeader } from "./header.js";
export {
  MessageList,
  CompactMessageItem,
  StreamingMessage,
} from "./message-list.js";
export {
  CommandInput,
  MinimalCommandInput,
  MultiLineInput,
  CommandPalette,
} from "./command-input.js";
export {
  StatusBar,
  CompactStatusBar,
  DetailedStatusBar,
} from "./status-bar.js";

// Animated status verbs (personality)
export {
  AnimatedStatusVerb,
  StatusLine,
  InlineStatus,
  useStatusVerb,
} from "./status-verb.js";

// Evidence and validation panel
export {
  EvidencePanel,
  ConfidenceMeter,
  StepPanel,
  ValidationReportPanel,
} from "./evidence-panel.js";

// Gentleman input (with lines above/below)
export {
  GentlemanInput,
  GentlemanInputMinimal,
} from "./gentleman-input.js";

// Ghost text suggestions
export {
  GhostInput,
  GhostText,
  GhostCommandInput,
  SuggestionPreview,
  SourceIcon,
} from "./ghost-suggestion.js";

// Enhanced status bar
export {
  EnhancedStatusBar,
} from "./status-bar.js";

// Selection inputs and dialogs
export {
  SelectInput,
  ConfirmDialog,
  QuickMenu,
  ModelSelector,
  ProviderSelector,
} from "./select-input.js";
export type {
  SelectOption,
  SelectInputProps,
  ConfirmDialogProps,
  QuickAction,
  QuickMenuProps,
  ModelSelectorProps,
  ProviderOption,
  ProviderSelectorProps,
} from "./select-input.js";

// Image input and attachment
export {
  ImageInput,
  ImageBadge,
  ImageIndicator,
  useImageInput,
  isImagePath,
  extractImagePaths,
  readImageFile,
  generateIterm2Image,
  supportsIterm2Images,
} from "./image-input.js";
export type { ImageAttachment, ImageInputProps } from "./image-input.js";
