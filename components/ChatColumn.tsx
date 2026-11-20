"use client";

import { Composer } from "@/components/Composer";
import { MessageList } from "@/components/MessageList";
import type { SendOutcome } from "@/components/useSingleConversation";
import type { VisibleMessage } from "@/lib/conversation/types";

interface ChatColumnProps {
  messages: VisibleMessage[];
  errorMessage: string;
  isLoadingHistory: boolean;
  isStreaming: boolean;
  onSend: (content: string) => Promise<SendOutcome>;
  onStop: () => void;
}

export function ChatColumn({
  messages,
  errorMessage,
  isLoadingHistory,
  isStreaming,
  onSend,
  onStop,
}: ChatColumnProps) {
  return (
    <main className="chat-column">
      <header className="chat-header">
        <h1>关系认知顾问</h1>
      </header>
      <section className="chat-scroll" aria-live="polite">
        <MessageList
          messages={messages}
          isLoadingHistory={isLoadingHistory}
          hasConnectionError={errorMessage.length > 0}
        />
      </section>
      <Composer
        isStreaming={isStreaming}
        errorMessage={errorMessage}
        onSend={onSend}
        onStop={onStop}
      />
    </main>
  );
}
