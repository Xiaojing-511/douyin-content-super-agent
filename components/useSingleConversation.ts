"use client";

/**
 * 页面上这一个聊天框的状态。
 *
 * 打开时先向服务器读取历史，所以刷新不会丢。
 * 发送时先在本地放上用户消息和一条空的助手消息，再把 SSE 增量填进助手消息。
 * 收到 done 之后重新读取历史，用数据库里的记录替换本地临时消息。
 * 停止生成不立刻断开这次 fetch。服务端停下模型，把已经展示的半截回复入库，再发 done。
 * 一个字都还没出现就停止的，这一轮不入库，原文放回输入框。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ConversationCancelledError,
  ConversationRequestError,
  loadConversationHistory,
  requestStopGeneration,
  streamReply,
} from "@/components/conversationClient";
import { clientLogger } from "@/components/clientLogger";
import { parseProcessStep, stepFromTool, upsertProcessStep, writeStep } from "@/lib/conversation/process";
import type { ConversationHistory, ExportLink, ProcessStep, VisibleMessage } from "@/lib/conversation/types";

export type SendOutcome = "completed" | "cancelled" | "failed";

const EMPTY_ASSISTANT_LOCAL_KEY = "streaming-assistant";
const HISTORY_RETRY_LIMIT = 8;
const HISTORY_RETRY_WAIT_MS = 150;

interface SingleConversationState {
  messages: VisibleMessage[];
  errorMessage: string;
  isLoadingHistory: boolean;
  isStreaming: boolean;
  sendMessage: (content: string, options: { webSearch: boolean }) => Promise<SendOutcome>;
  stopGeneration: () => void;
}

export function useSingleConversation(): SingleConversationState {
  const [messages, setMessages] = useState<VisibleMessage[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const stopControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const applyHistory = useCallback((history: ConversationHistory) => {
    setMessages(
      history.messages.map((message) => ({
        localKey: `saved-${message.id}`,
        role: message.role,
        content: message.content,
        process: message.process ?? undefined,
      })),
    );
    clientLogger.info("页面已换成数据库里的对话", {
      条数: history.messages.length,
      消息: history.messages.map((message) => ({
        角色: message.role === "user" ? "用户" : "顾问",
        内容: message.content,
      })),
    });
  }, []);

  const replaceWithSavedHistory = useCallback(async (): Promise<ConversationHistory> => {
    const history = await loadConversationHistory();
    applyHistory(history);
    return history;
  }, [applyHistory]);

  useEffect(() => {
    let ignoreLateResponse = false;
    clientLogger.info("打开页面，开始读取已保存的对话");
    replaceWithSavedHistory()
      .catch((error: unknown) => {
        if (ignoreLateResponse) {
          return;
        }
        const message =
          error instanceof ConversationRequestError
            ? error.message
            : "连不上顾问服务。请确认应用和数据库已启动。";
        setErrorMessage(message);
        clientLogger.error("历史读取失败", { 原因: message });
      })
      .finally(() => {
        if (!ignoreLateResponse) {
          setIsLoadingHistory(false);
        }
      });
    return () => {
      ignoreLateResponse = true;
    };
  }, [replaceWithSavedHistory]);

  const stopGeneration = useCallback(() => {
    const controller = stopControllerRef.current;
    stopRequestedRef.current = true;
    clientLogger.info("请求停止生成");
    void requestStopGeneration().then((stopped) => {
      if (!stopped && stopRequestedRef.current && stopControllerRef.current === controller) {
        clientLogger.info("停止请求没有对上当前这一轮，改为中断连接");
        controller?.abort();
      }
    });
  }, []);

  const sendMessage = useCallback(
    async (content: string, options: { webSearch: boolean }): Promise<SendOutcome> => {
      const trimmedContent = content.trim();
      if (!trimmedContent || isStreaming) {
        return "failed";
      }

      const savedCountBeforeSend = messagesRef.current.filter((message) =>
        message.localKey.startsWith("saved-"),
      ).length;
      const stopController = new AbortController();
      stopControllerRef.current = stopController;
      stopRequestedRef.current = false;
      setErrorMessage("");
      setIsStreaming(true);
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          localKey: `pending-user-${Date.now()}`,
          role: "user",
          content: trimmedContent,
        },
        {
          localKey: EMPTY_ASSISTANT_LOCAL_KEY,
          role: "assistant",
          content: "",
          live: true,
        },
      ]);
      clientLogger.info("页面开始发送，先放上用户消息", {
        内容: trimmedContent,
        字数: Array.from(trimmedContent).length,
      });

      let receivedDeltaCount = 0;
      let assistantText = "";
      let streamWasPersisted = false;
      try {
        await streamReply(
          trimmedContent,
          {
            onDelta: (deltaText) => {
              receivedDeltaCount += 1;
              assistantText += deltaText;
              if (receivedDeltaCount === 1) {
                clientLogger.info("页面开始显示模型回复");
              }
              setMessages((currentMessages) =>
                currentMessages.map((message) =>
                  message.localKey === EMPTY_ASSISTANT_LOCAL_KEY
                    ? {
                        ...message,
                        content: message.content + deltaText,
                        process: upsertProcessStep(message.process ?? [], writeStep()),
                      }
                    : message,
                ),
              );
            },
            onStatus: (status) => {
              const step = parseProcessStep(status);
              if (!step) {
                return;
              }
              setMessages((currentMessages) => updateStreamingProcess(currentMessages, step));
            },
            onTool: (tool) => {
              setMessages((currentMessages) => updateStreamingProcess(currentMessages, stepFromTool(tool)));
            },
            onFile: (file) => {
              setMessages((currentMessages) =>
                currentMessages.map((message) =>
                  message.localKey === EMPTY_ASSISTANT_LOCAL_KEY
                    ? { ...message, exports: addExport(message.exports, file) }
                    : message,
                ),
              );
            },
            onDone: () => {
              streamWasPersisted = true;
              clientLogger.info("模型回复已显示完整", {
                增量段数: receivedDeltaCount,
                字数: Array.from(assistantText).length,
                内容: assistantText,
              });
            },
            onStreamError: (message) => {
              setErrorMessage(message);
            },
          },
          stopController.signal,
          () => stopRequestedRef.current,
          options.webSearch,
        );
        if (streamWasPersisted) {
          try {
            clientLogger.info("回复已结束，开始重新读取已保存的对话");
            await replaceWithSavedHistory();
          } catch {
            setErrorMessage("回复已经保存，但没有重新读到历史。刷新页面即可看到。");
            clientLogger.error("重新读取历史失败");
          }
          return "completed";
        }
        return "failed";
      } catch (error: unknown) {
        const interrupted =
          error instanceof ConversationCancelledError ||
          (receivedDeltaCount > 0 && error instanceof ConversationRequestError);
        if (interrupted) {
          clientLogger.info("生成被中断", {
            增量段数: receivedDeltaCount,
            已显示字数: Array.from(assistantText).length,
          });
          return await settleInterruptedTurn(
            savedCountBeforeSend,
            receivedDeltaCount,
            error instanceof ConversationCancelledError ? "cancelled" : "dropped",
            applyHistory,
            setErrorMessage,
          );
        }
        const message =
          error instanceof ConversationRequestError ? error.message : "这一轮没有完成。";
        setErrorMessage(message);
        clientLogger.error("回复没有完成", { 原因: message });
        return "failed";
      } finally {
        stopRequestedRef.current = false;
        if (stopControllerRef.current === stopController) {
          stopControllerRef.current = null;
        }
        setMessages((currentMessages) =>
          currentMessages.map((message) =>
            message.localKey === EMPTY_ASSISTANT_LOCAL_KEY ? { ...message, live: false } : message,
          ),
        );
        setIsStreaming(false);
      }
    },
    [applyHistory, isStreaming, replaceWithSavedHistory],
  );

  return {
    messages,
    errorMessage,
    isLoadingHistory,
    isStreaming,
    sendMessage,
    stopGeneration,
  };
}

/**
 * 流没有正常读到 done 时，再向数据库确认这一轮有没有写入。
 * 已经展示过的回复会留在屏幕上，直到确认入库后才换成历史记录。
 * 一个字都还没出现就停止的，清掉临时气泡，把原文放回输入框。
 */
async function settleInterruptedTurn(
  savedCountBeforeSend: number,
  receivedDeltaCount: number,
  reason: "cancelled" | "dropped",
  applyHistory: (history: ConversationHistory) => void,
  setErrorMessage: (message: string) => void,
): Promise<SendOutcome> {
  const sawReply = receivedDeltaCount > 0;
  const attempts = sawReply ? HISTORY_RETRY_LIMIT : 1;
  let lastHistory: ConversationHistory | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastHistory = await loadConversationHistory();
      if (lastHistory.messages.length > savedCountBeforeSend) {
        applyHistory(lastHistory);
        return "completed";
      }
    } catch {
      lastHistory = null;
    }
    if (attempt < attempts - 1) {
      await wait(HISTORY_RETRY_WAIT_MS);
    }
  }

  if (sawReply) {
    setErrorMessage(
      lastHistory
        ? "已停止生成，但这一轮没有写入数据库。刷新后刚看到的回复会消失。"
        : "已停止生成。回复还在页面上，但没有确认是否写入。刷新后以数据库为准。",
    );
    clientLogger.error("中断后没有确认这一轮是否写入");
    return "failed";
  }

  if (reason === "cancelled" && lastHistory) {
    applyHistory(lastHistory);
    setErrorMessage("已停止生成。这一轮没有保存。");
    return "cancelled";
  }

  setErrorMessage(
    reason === "cancelled"
      ? "已停止生成。这一轮没有保存。刷新页面即可回到已保存的对话。"
      : "这一轮没有保存。连接在结束前断开了。",
  );
  return "failed";
}

function updateStreamingProcess(currentMessages: VisibleMessage[], step: ProcessStep): VisibleMessage[] {
  return currentMessages.map((message) =>
    message.localKey === EMPTY_ASSISTANT_LOCAL_KEY
      ? { ...message, process: upsertProcessStep(message.process ?? [], step) }
      : message,
  );
}

function addExport(current: ExportLink[] | undefined, file: ExportLink): ExportLink[] {
  const existing = current ?? [];
  if (existing.some((item) => item.fileId === file.fileId)) {
    return existing;
  }
  return [...existing, file];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
