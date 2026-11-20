"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";

import type { SendOutcome } from "@/components/useSingleConversation";

interface ComposerProps {
  isStreaming: boolean;
  errorMessage: string;
  onSend: (content: string) => Promise<SendOutcome>;
  onStop: () => void;
}

export function Composer({ isStreaming, errorMessage, onSend, onStop }: ComposerProps) {
  const [draft, setDraft] = useState("");

  async function submitDraft() {
    const content = draft.trim();
    if (!content || isStreaming) {
      return;
    }
    setDraft("");
    const outcome = await onSend(content);
    if (outcome === "cancelled") {
      setDraft(content);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitDraft();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitDraft();
    }
  }

  return (
    <form className="composer-wrap" onSubmit={handleSubmit}>
      {errorMessage ? <p className="error-notice">{errorMessage}</p> : null}
      <div className="composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="写一句想聊的话"
          rows={1}
          disabled={isStreaming}
          aria-label="消息输入"
        />
        {isStreaming ? (
          <button type="button" onClick={onStop}>
            停止生成
          </button>
        ) : (
          <button type="submit" disabled={draft.trim().length === 0}>
            发送
          </button>
        )}
      </div>
    </form>
  );
}
