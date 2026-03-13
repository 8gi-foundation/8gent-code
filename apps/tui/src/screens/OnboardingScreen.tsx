import React from "react";
import { MessageList } from "../components/message-list.js";
import { Heading, MutedText, AppText, Inline, Stack } from "../components/primitives/index.js";
import type { Message } from "../app.js";

interface OnboardingScreenProps {
  messages: Message[];
  animateTyping: boolean;
  soundEnabled: boolean;
}

export function OnboardingScreen({ messages, animateTyping, soundEnabled }: OnboardingScreenProps) {
  return (
    <Stack>
      <Inline>
        <Heading>∞ Onboarding</Heading>
        <MutedText> - </MutedText>
        <AppText color="yellow">Getting to know you</AppText>
      </Inline>
      <MessageList
        messages={messages}
        animateTyping={animateTyping}
        soundEnabled={soundEnabled}
      />
    </Stack>
  );
}
