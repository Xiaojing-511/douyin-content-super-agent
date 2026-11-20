/**
 * 页面和本机接口之间的对话请求。
 *
 * 发送使用 POST，所以不能用浏览器自带的 EventSource（它只能 GET）。
 * 这里用 fetch 读响应流，再交给 ServerSentEventBuffer 拆事件。
 * 「停止生成」先请求服务端停下这一轮，原来的 POST 继续读到 done。
 * 这样已经展示的半截回复会入库，页面不会把看到的字清掉。
 * 停止请求没有对上当前这一轮时，才退回中止这次 fetch。
 * trace 事件只打到控制台，用来看检索和模型请求，不进入聊天记录。
 */

import { clientLogger } from "@/components/clientLogger";
import { ServerSentEventBuffer } from "@/lib/conversation/parse-server-sent-events";
import type {
  ConversationHistory,
  MessageDeltaData,
  StreamDoneData,
  StreamErrorData,
  StreamTraceData,
} from "@/lib/conversation/types";

export class ConversationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationRequestError";
  }
}

/** 用户点击停止，或这次 fetch 的 signal 已被中止。不是连接故障。 */
export class ConversationCancelledError extends Error {
  constructor() {
    super("已停止生成");
    this.name = "ConversationCancelledError";
  }
}

export async function loadConversationHistory(): Promise<ConversationHistory> {
  clientLogger.info("开始请求历史接口", { 路径: "/api/chat/messages" });
  const response = await fetch("/api/chat/messages");
  if (!response.ok) {
    clientLogger.error("历史接口没有返回对话", { 状态码: response.status });
    throw new ConversationRequestError("暂时读不到已保存的对话");
  }
  const history = (await response.json()) as ConversationHistory;
  clientLogger.info("历史接口已返回", {
    会话: history.threadId,
    条数: history.messages.length,
  });
  return history;
}

/** 让服务端停下当前这一轮。返回 false 表示这一轮已经结束，或停止请求没有送到。 */
export async function requestStopGeneration(): Promise<boolean> {
  clientLogger.info("开始请求停止接口", { 路径: "/api/chat/runs/stop" });
  try {
    const response = await fetch("/api/chat/runs/stop", { method: "POST" });
    if (!response.ok) {
      clientLogger.error("停止接口没有成功", { 状态码: response.status });
      return false;
    }
    const body = (await response.json()) as { stopped?: boolean };
    const stopped = body.stopped === true;
    clientLogger.info("停止接口已返回", { 已停下: stopped });
    return stopped;
  } catch {
    clientLogger.error("停止接口没有送到");
    return false;
  }
}

export interface StreamHandlers {
  onDelta: (deltaText: string) => void;
  onDone: (doneData: StreamDoneData) => void;
  onStreamError: (message: string) => void;
}

export async function streamReply(
  content: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
  isStopRequested: () => boolean = () => false,
): Promise<void> {
  clientLogger.info("开始请求对话接口", { 路径: "/api/chat/runs", 内容: content });
  let response: Response;
  try {
    response = await fetch("/api/chat/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ content }),
      signal,
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new ConversationCancelledError();
    }
    clientLogger.error("连不上对话接口");
    throw new ConversationRequestError("连不上顾问服务。请确认应用已启动。");
  }

  if (!response.ok || !response.body) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = "";
    }
    clientLogger.error("对话接口没有开始回复", { 状态码: response.status, 响应: detail });
    throw new ConversationRequestError("顾问服务没有开始回复。");
  }

  clientLogger.info("对话接口已连接，开始读取事件流", { 状态码: response.status });

  const eventBuffer = new ServerSentEventBuffer();
  const textDecoder = new TextDecoder();
  const reader = response.body.getReader();
  let sawDone = false;
  let sawError = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const textChunk = textDecoder.decode(value, { stream: true });
      for (const serverEvent of eventBuffer.consume(textChunk)) {
        if (serverEvent.eventName === "done") {
          sawDone = true;
        }
        if (serverEvent.eventName === "error") {
          sawError = true;
        }
        dispatchServerEvent(serverEvent.eventName, serverEvent.data, handlers);
      }
    }
  } catch (error: unknown) {
    if (sawDone) {
      return;
    }
    if (isAbortError(error) || signal.aborted || isStopRequested()) {
      throw new ConversationCancelledError();
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 读取已经因中止失败时，再释放锁可能抛错。这个错误不能盖住「已停止生成」。
    }
  }

  if (sawDone || sawError) {
    return;
  }
  if (signal.aborted || isStopRequested()) {
    throw new ConversationCancelledError();
  }
  clientLogger.error("连接在结束前断开了");
  throw new ConversationRequestError("这一轮没有保存。连接在结束前断开了。");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function dispatchServerEvent(eventName: string, data: unknown, handlers: StreamHandlers): void {
  if (eventName === "trace") {
    const traceData = data as StreamTraceData;
    const step = typeof traceData?.step === "string" ? traceData.step : "服务端步骤";
    clientLogger.info(step, traceData?.detail);
    return;
  }
  if (eventName === "message.delta") {
    const deltaData = data as MessageDeltaData;
    handlers.onDelta(deltaData.delta);
    return;
  }
  if (eventName === "done") {
    const doneData = data as StreamDoneData;
    clientLogger.info("收到结束事件", { 会话: doneData.threadId });
    handlers.onDone(doneData);
    return;
  }
  if (eventName === "error") {
    const errorData = data as StreamErrorData;
    clientLogger.error("收到错误事件", { 原因: errorData.message });
    handlers.onStreamError(errorData.message);
  }
}
