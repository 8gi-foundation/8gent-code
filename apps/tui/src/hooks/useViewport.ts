import { useState, useEffect } from "react";
import { useStdout } from "ink";

export interface Viewport {
  width: number;
  height: number;
}

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 24;

export function useViewport(): Viewport {
  const { stdout } = useStdout();

  const [viewport, setViewport] = useState<Viewport>(() => ({
    width: stdout?.columns ?? DEFAULT_WIDTH,
    height: stdout?.rows ?? DEFAULT_HEIGHT,
  }));

  useEffect(() => {
    if (!stdout) {
      return;
    }

    const handleResize = () => {
      setViewport({
        width: stdout.columns ?? DEFAULT_WIDTH,
        height: stdout.rows ?? DEFAULT_HEIGHT,
      });
    };

    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  return viewport;
}
