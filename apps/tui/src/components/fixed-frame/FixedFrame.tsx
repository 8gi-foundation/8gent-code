import React from "react";
import { Box } from "ink";
import { useViewport } from "../../hooks/useViewport.js";

interface FixedFrameProps {
  children: React.ReactNode;
}

export function FixedFrame({ children }: FixedFrameProps) {
  const viewport = useViewport();

  return (
    <Box
      height={viewport.height}
      width="100%"
      flexDirection="column"
      overflow="hidden"
    >
      {children}
    </Box>
  );
}
