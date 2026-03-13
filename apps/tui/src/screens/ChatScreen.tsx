import React from "react";
import { MessageList } from "../components/message-list.js";
import type { Message } from "../app.js";

interface ChatScreenProps {
  messages: Message[];
  animateTyping: boolean;
  soundEnabled: boolean;
}

export function ChatScreen({ messages, animateTyping, soundEnabled }: ChatScreenProps) {
  return (
    <MessageList
      messages={messages}
      animateTyping={animateTyping}
      soundEnabled={soundEnabled}
    />
  );
}
