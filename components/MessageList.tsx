"use client";

import { useEffect, useRef } from "react";

import type { VisibleMessage } from "@/lib/conversation/types";

interface MessageListProps {
  messages: VisibleMessage[];
  isLoadingHistory: boolean;
  hasConnectionError: boolean;
}

export function MessageList({ messages, isLoadingHistory, hasConnectionError }: MessageListProps) {
  const bottomMarkerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomMarkerRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (isLoadingHistory) {
    return <p className="history-status">正在读取这一段对话</p>;
  }

  if (messages.length === 0 && !hasConnectionError) {
    return (
      <p className="empty-hint">
        描述一个相处里的具体画面。例如：冲突之后为什么会一直想这件事。
      </p>
    );
  }

  return (
    <div className="message-list">
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.localKey} className="user-row">
            <p className="user-bubble">{message.content}</p>
          </div>
        ) : (
          <p key={message.localKey} className="assistant-text">
            {message.content}
          </p>
        ),
      )}
      <div ref={bottomMarkerRef} />
    </div>
  );
}
