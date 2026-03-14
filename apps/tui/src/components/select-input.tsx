/**
 * 8gent Code - Select Input Component
 *
 * Scrollable selection menus for options like:
 * - Yes/No confirmations
 * - Model selection
 * - Provider selection
 * - Any list of choices
 *
 * Features:
 * - Arrow key navigation (up/down)
 * - Enter to select
 * - Escape to cancel
 * - Search/filter while typing
 * - Highlighted current selection
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Heading, Label, Badge, Card, Stack, Inline, Spacer } from './primitives/index.js';

// ============================================
// Types
// ============================================

export interface SelectOption<T = string> {
  label: string;
  value: T;
  description?: string;
  disabled?: boolean;
  icon?: string;
}

export interface SelectInputProps<T = string> {
  options: SelectOption<T>[];
  onSelect: (value: T) => void;
  onCancel?: () => void;
  title?: string;
  initialIndex?: number;
  maxVisible?: number;
  showDescription?: boolean;
  searchable?: boolean;
  highlightColor?: string;
}

// ============================================
// Main Select Input Component
// ============================================

export function SelectInput<T = string>({
  options,
  onSelect,
  onCancel,
  title,
  initialIndex = 0,
  maxVisible = 8,
  showDescription = true,
  searchable = true,
  highlightColor = "cyan",
}: SelectInputProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [search, setSearch] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);

  // Filter options based on search
  const filteredOptions = searchable && search
    ? options.filter(opt =>
        opt.label.toLowerCase().includes(search.toLowerCase()) ||
        opt.description?.toLowerCase().includes(search.toLowerCase())
      )
    : options;

  // Ensure selection is within bounds
  useEffect(() => {
    if (selectedIndex >= filteredOptions.length) {
      setSelectedIndex(Math.max(0, filteredOptions.length - 1));
    }
  }, [filteredOptions.length, selectedIndex]);

  // Handle scroll when selection goes out of view
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + maxVisible) {
      setScrollOffset(selectedIndex - maxVisible + 1);
    }
  }, [selectedIndex, scrollOffset, maxVisible]);

  // Handle keyboard input
  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }

    if (key.return) {
      const selected = filteredOptions[selectedIndex];
      if (selected && !selected.disabled) {
        onSelect(selected.value);
      }
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => {
        let next = prev + 1;
        // Skip disabled options
        while (next < filteredOptions.length && filteredOptions[next]?.disabled) {
          next++;
        }
        return Math.min(next, filteredOptions.length - 1);
      });
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(prev => {
        let next = prev - 1;
        // Skip disabled options
        while (next >= 0 && filteredOptions[next]?.disabled) {
          next--;
        }
        return Math.max(next, 0);
      });
      return;
    }

    // Searchable - handle typing
    if (searchable && input && !key.ctrl && !key.meta) {
      setSearch(prev => prev + input);
      setSelectedIndex(0);
      setScrollOffset(0);
    }

    // Backspace for search
    if (key.backspace || key.delete) {
      setSearch(prev => prev.slice(0, -1));
    }
  });

  // Visible slice of options
  const visibleOptions = filteredOptions.slice(scrollOffset, scrollOffset + maxVisible);
  const hasMore = filteredOptions.length > maxVisible;
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset + maxVisible < filteredOptions.length;

  return (
    <Card borderColor="blue">
      {/* Title */}
      {title && (
        <Box marginBottom={1}>
          <Heading color={highlightColor as any}>
            {title}
          </Heading>
        </Box>
      )}

      {/* Search input (if searchable and has search) */}
      {searchable && search && (
        <Inline gap={0} marginBottom={1}>
          <MutedText>Search: </MutedText>
          <AppText color="yellow">{search}</AppText>
          <MutedText> (Backspace to clear)</MutedText>
        </Inline>
      )}

      {/* Scroll up indicator */}
      {hasMore && canScrollUp && (
        <Box>
          <MutedText>  ▲ {scrollOffset} more above</MutedText>
        </Box>
      )}

      {/* Options */}
      {visibleOptions.map((option, index) => {
        const actualIndex = scrollOffset + index;
        const isSelected = actualIndex === selectedIndex;
        const isDisabled = option.disabled;

        return (
          <Stack key={String(option.value)} gap={0}>
            <Inline gap={0}>
              {/* Selection indicator */}
              <AppText color={isSelected ? highlightColor as any : "gray"}>
                {isSelected ? "❯ " : "  "}
              </AppText>

              {/* Icon if present */}
              {option.icon && (
                <AppText dimColor={isDisabled} bold={!isDisabled}>
                  {option.icon}{" "}
                </AppText>
              )}

              {/* Label */}
              {isDisabled ? (
                <MutedText>
                  {option.label}
                </MutedText>
              ) : (
                <AppText
                  color={isSelected ? highlightColor as any : undefined}
                  bold={isSelected || !isDisabled}
                >
                  {option.label}
                </AppText>
              )}

              {/* Disabled indicator */}
              {isDisabled && (
                <MutedText> (unavailable)</MutedText>
              )}
            </Inline>

            {/* Description (only for selected item) */}
            {showDescription && isSelected && option.description && (
              <Box paddingLeft={4}>
                <MutedText>
                  {option.description}
                </MutedText>
              </Box>
            )}
          </Stack>
        );
      })}

      {/* Scroll down indicator */}
      {hasMore && canScrollDown && (
        <Box>
          <MutedText>
            {"  "}▼ {filteredOptions.length - scrollOffset - maxVisible} more below
          </MutedText>
        </Box>
      )}

      {/* Empty state */}
      {filteredOptions.length === 0 && (
        <Box>
          <MutedText>No options match "{search}"</MutedText>
        </Box>
      )}

      {/* Help text */}
      <Box marginTop={1}>
        <MutedText>
          [↑↓] Navigate  [Enter] Select  [Esc] Cancel
        </MutedText>
      </Box>
    </Card>
  );
}

// ============================================
// Quick Yes/No Confirm Dialog
// ============================================

export interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  defaultYes?: boolean;
  yesLabel?: string;
  noLabel?: string;
}

export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  defaultYes = false,
  yesLabel = "Yes",
  noLabel = "No",
}: ConfirmDialogProps) {
  const [selected, setSelected] = useState(defaultYes ? 0 : 1);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (selected === 0) {
        onConfirm();
      } else {
        onCancel();
      }
      return;
    }

    if (key.leftArrow || key.upArrow) {
      setSelected(0);
    }

    if (key.rightArrow || key.downArrow) {
      setSelected(1);
    }

    // Y for yes, N for no
    if (input?.toLowerCase() === "y") {
      onConfirm();
    } else if (input?.toLowerCase() === "n") {
      onCancel();
    }
  });

  return (
    <Card borderColor="yellow">
      <AppText color="yellow">{message}</AppText>
      <Inline gap={2} marginTop={1}>
        <AppText
          color={selected === 0 ? "green" : "gray"}
          bold={selected === 0}
        >
          {selected === 0 ? "❯ " : "  "}
          {yesLabel}
        </AppText>
        <AppText
          color={selected === 1 ? "red" : "gray"}
          bold={selected === 1}
        >
          {selected === 1 ? "❯ " : "  "}
          {noLabel}
        </AppText>
      </Inline>
      <Box marginTop={1}>
        <MutedText>
          [Y/N] or [←→] to select, [Enter] to confirm
        </MutedText>
      </Box>
    </Card>
  );
}

// ============================================
// Quick Action Menu (like command palette)
// ============================================

export interface QuickAction<T = string> {
  label: string;
  value: T;
  shortcut?: string;
  icon?: string;
}

export interface QuickMenuProps<T = string> {
  actions: QuickAction<T>[];
  onSelect: (value: T) => void;
  onCancel?: () => void;
  title?: string;
}

export function QuickMenu<T = string>({
  actions,
  onSelect,
  onCancel,
  title = "Quick Actions",
}: QuickMenuProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }

    if (key.return) {
      onSelect(actions[selectedIndex].value);
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(prev + 1, actions.length - 1));
    }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    }

    // Check for shortcut key
    const action = actions.find(a =>
      a.shortcut?.toLowerCase() === input?.toLowerCase()
    );
    if (action) {
      onSelect(action.value);
    }
  });

  return (
    <Card borderColor="cyan">
      <Heading>{title}</Heading>
      <Stack marginTop={1}>
        {actions.map((action, index) => (
          <Inline gap={0} key={String(action.value)}>
            <Label
              color={index === selectedIndex ? "cyan" : undefined}
            >
              {index === selectedIndex ? "❯ " : "  "}
              {action.icon && `${action.icon} `}
              {action.label}
            </Label>
            {action.shortcut && (
              <MutedText> [{action.shortcut}]</MutedText>
            )}
          </Inline>
        ))}
      </Stack>
    </Card>
  );
}

// ============================================
// Model Selector (Pre-built)
// ============================================

export interface ModelSelectorProps {
  models: string[];
  currentModel: string;
  onSelect: (model: string) => void;
  onCancel: () => void;
  provider?: string;
}

export function ModelSelector({
  models,
  currentModel,
  onSelect,
  onCancel,
  provider = "Ollama",
}: ModelSelectorProps) {
  const options: SelectOption<string>[] = models.map(model => ({
    label: model,
    value: model,
    icon: model === currentModel ? "✓" : " ",
    description: model === currentModel ? "Currently active" : undefined,
  }));

  const currentIndex = models.findIndex(m => m === currentModel);

  return (
    <SelectInput
      title={`Select Model (${provider})`}
      options={options}
      onSelect={onSelect}
      onCancel={onCancel}
      initialIndex={Math.max(0, currentIndex)}
      highlightColor="green"
    />
  );
}

// ============================================
// Provider Selector (Pre-built)
// ============================================

export interface ProviderOption {
  name: string;
  displayName: string;
  hasApiKey: boolean;
  enabled: boolean;
}

export interface ProviderSelectorProps {
  providers: ProviderOption[];
  currentProvider: string;
  onSelect: (provider: string) => void;
  onCancel: () => void;
}

export function ProviderSelector({
  providers,
  currentProvider,
  onSelect,
  onCancel,
}: ProviderSelectorProps) {
  const options: SelectOption<string>[] = providers.map(p => ({
    label: p.displayName,
    value: p.name,
    icon: p.name === currentProvider ? "✓" : p.hasApiKey ? "🔑" : " ",
    description: p.name === currentProvider
      ? "Currently active"
      : p.hasApiKey
      ? "API key configured"
      : "No API key (requires setup)",
    disabled: !p.enabled && p.name !== "ollama",
  }));

  const currentIndex = providers.findIndex(p => p.name === currentProvider);

  return (
    <SelectInput
      title="Select Provider"
      options={options}
      onSelect={onSelect}
      onCancel={onCancel}
      initialIndex={Math.max(0, currentIndex)}
      highlightColor="magenta"
    />
  );
}

// ============================================
// Exports
// ============================================

export default {
  SelectInput,
  ConfirmDialog,
  QuickMenu,
  ModelSelector,
  ProviderSelector,
};
