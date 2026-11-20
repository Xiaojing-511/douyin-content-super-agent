"use client";

import { ChatColumn } from "@/components/ChatColumn";
import { useSingleConversation } from "@/components/useSingleConversation";

export function ChatApp() {
  const conversation = useSingleConversation();
  return (
    <ChatColumn
      messages={conversation.messages}
      errorMessage={conversation.errorMessage}
      isLoadingHistory={conversation.isLoadingHistory}
      isStreaming={conversation.isStreaming}
      onSend={conversation.sendMessage}
      onStop={conversation.stopGeneration}
    />
  );
}
