import React from "react";
import type { Message } from "../app.js";
import { MessageList } from "../components/message-list.js";

interface ChatScreenProps {
	messages: Message[];
	animateTyping: boolean;
	soundEnabled: boolean;
}

export function ChatScreen({
	messages,
	animateTyping,
	soundEnabled,
}: ChatScreenProps) {
	return (
		<MessageList
			messages={messages}
			animateTyping={animateTyping}
			soundEnabled={soundEnabled}
		/>
	);
}
