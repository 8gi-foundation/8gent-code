import { useInput, type Key } from "ink";

export interface HotkeyBindings {
  up?: () => void;
  down?: () => void;
  left?: () => void;
  right?: () => void;
  enter?: () => void;
  escape?: () => void;
  tab?: () => void;
  delete?: () => void;
  ctrlC?: () => void;
  ctrlO?: () => void;
  ctrlK?: () => void;
  ctrlA?: () => void;
  ctrlS?: () => void;
  ctrlP?: () => void;
  q?: () => void;
  number?: (n: number) => void;
}

export function useHotkeys(
  bindings: HotkeyBindings,
  active: boolean = true,
): void {
  useInput(
    (input: string, key: Key) => {
      if (!active) {
        return;
      }

      // Ctrl combinations — check these first since they may overlap with letter keys
      if (key.ctrl) {
        if (input === "c" && bindings.ctrlC) {
          bindings.ctrlC();
          return;
        }
        if (input === "o" && bindings.ctrlO) {
          bindings.ctrlO();
          return;
        }
        if (input === "k" && bindings.ctrlK) {
          bindings.ctrlK();
          return;
        }
        if (input === "a" && bindings.ctrlA) {
          bindings.ctrlA();
          return;
        }
        if (input === "s" && bindings.ctrlS) {
          bindings.ctrlS();
          return;
        }
        if (input === "p" && bindings.ctrlP) {
          bindings.ctrlP();
          return;
        }
        return;
      }

      // Arrow keys
      if (key.upArrow && bindings.up) {
        bindings.up();
        return;
      }
      if (key.downArrow && bindings.down) {
        bindings.down();
        return;
      }
      if (key.leftArrow && bindings.left) {
        bindings.left();
        return;
      }
      if (key.rightArrow && bindings.right) {
        bindings.right();
        return;
      }

      // Special keys
      if (key.return && bindings.enter) {
        bindings.enter();
        return;
      }
      if (key.escape && bindings.escape) {
        bindings.escape();
        return;
      }
      if (key.tab && bindings.tab) {
        bindings.tab();
        return;
      }
      if ((key.delete || key.backspace) && bindings.delete) {
        bindings.delete();
        return;
      }

      // Literal 'q' key (not ctrl+q)
      if (input === "q" && bindings.q) {
        bindings.q();
        return;
      }

      // Number keys 1-9
      if (bindings.number) {
        const n = parseInt(input, 10);
        if (n >= 1 && n <= 9) {
          bindings.number(n);
          return;
        }
      }
    },
    { isActive: active },
  );
}
