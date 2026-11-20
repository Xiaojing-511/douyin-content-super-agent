"use client";

import { useEffect, useRef } from "react";

import { dedupeExportLinks, splitExportMarkers } from "@/lib/exports/marker";
import type { ExportLink, VisibleMessage } from "@/lib/conversation/types";

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
          <AssistantMessage key={message.localKey} message={message} />
        ),
      )}
      <div ref={bottomMarkerRef} />
    </div>
  );
}

function AssistantMessage({ message }: { message: VisibleMessage }) {
  const parsed = splitExportMarkers(message.content);
  const files = dedupeExportLinks([...(message.exports ?? []), ...parsed.files]);
  return (
    <div className="assistant-block">
      {parsed.body ? <p className="assistant-text">{parsed.body}</p> : null}
      {message.activity ? <p className="tool-status">{message.activity}</p> : null}
      {files.map((file) => (
        <ExportLinkView key={file.fileId} file={file} />
      ))}
    </div>
  );
}

function ExportLinkView({ file }: { file: ExportLink }) {
  return (
    <a className="export-link" href={`/api/exports/${file.fileId}`} download={`${file.title}.pdf`}>
      下载 PDF：{file.title}
    </a>
  );
}
