/**
 * SpawnRequestCard — Shown when Eight suggests spawning a sub-agent.
 * User presses y to approve, n to reject.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Stack, Inline } from "../primitives/index.js";

interface SpawnRequestCardProps {
  personaName: string;
  personaIcon: string;
  task: string;
  reason: string;
  onApprove: () => void;
  onReject: () => void;
}

export function SpawnRequestCard({
  personaName,
  personaIcon,
  task,
  reason,
  onApprove,
  onReject,
}: SpawnRequestCardProps) {
  useInput((input) => {
    if (input === "y" || input === "Y") onApprove();
    if (input === "n" || input === "N") onReject();
  });

  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Inline>
        <Text color="yellow" bold>
          {personaIcon} Spawn Request: {personaName}
        </Text>
      </Inline>
      <Stack>
        <AppText>Task: {task}</AppText>
        <MutedText>Reason: {reason}</MutedText>
        <Inline>
          <Text color="green" bold> [y] </Text>
          <MutedText>approve</MutedText>
          <Text color="red" bold> [n] </Text>
          <MutedText>reject</MutedText>
        </Inline>
      </Stack>
    </Box>
  );
}
