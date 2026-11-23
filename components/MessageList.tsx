"use client";

import { useEffect, useRef, useState } from "react";

import { hasVisibleProcess, processHeadline, WRITE_STEP_ID } from "@/lib/conversation/process";
import { dedupeExportLinks, splitExportMarkers } from "@/lib/exports/marker";
import type { ExportLink, ProcessStep, VisibleMessage } from "@/lib/conversation/types";

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
    <div className="assistant-row">
      <img className="assistant-avatar" src="/cat-logo.png" alt="" width={32} height={32} />
      <div className="assistant-block">
        <ProcessDisclosure steps={message.process} live={message.live === true} />
        {parsed.body ? <p className="assistant-text">{parsed.body}</p> : null}
        {files.map((file) => (
          <ExportLinkView key={file.fileId} file={file} />
        ))}
      </div>
    </div>
  );
}

function ProcessDisclosure({ steps, live }: { steps: ProcessStep[] | undefined; live: boolean }) {
  const [open, setOpen] = useState(live);
  const userChose = useRef(false);

  useEffect(() => {
    if (!userChose.current) {
      setOpen(live);
    }
  }, [live]);

  if (!hasVisibleProcess(steps)) {
    return null;
  }

  const list = (steps ?? []).filter((step) => live || step.id !== WRITE_STEP_ID);
  const headline = processHeadline(list, live);

  return (
    <div className="process">
      <button
        type="button"
        className="process-toggle"
        aria-expanded={open}
        onClick={() => {
          userChose.current = true;
          setOpen((current) => !current);
        }}
      >
        <span className="process-chevron" aria-hidden="true">
          {open ? "⌄" : "›"}
        </span>
        {open ? "收起过程" : headline}
      </button>
      {open ? (
        <ul className="process-list">
          {list.map((step) => (
            <li key={step.id} className={step.state === "running" ? "process-running" : undefined}>
              <span className="process-mark" aria-hidden="true">
                {markFor(step)}
              </span>
              <span>
                {step.state === "running" && step.detail ? step.title : lineText(step)}
                {step.state === "running" && step.detail ? <span className="process-detail">{step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function lineText(step: ProcessStep): string {
  if (step.id === WRITE_STEP_ID || !step.detail) {
    return step.title;
  }
  return `${step.title} · ${step.detail}`;
}

function markFor(step: ProcessStep): string {
  if (step.state === "running") {
    return "●";
  }
  if (step.state === "failed") {
    return "!";
  }
  if (step.state === "stopped") {
    return "–";
  }
  return "✓";
}

function ExportLinkView({ file }: { file: ExportLink }) {
  return (
    <a className="export-link" href={`/api/exports/${file.fileId}`} download={`${file.title}.pdf`}>
      下载 PDF：{file.title}
    </a>
  );
}
