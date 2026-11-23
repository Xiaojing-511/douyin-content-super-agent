/**
 * 把一个事件编码成 SSE 文本块。
 *
 * 一个事件在线上长这样：
 *
 *     event: message.delta
 *     data: {"delta":"你"}
 *
 *     （空行表示这个事件结束）
 *
 * 浏览器不能用 EventSource 读取发送接口，因为 EventSource 只支持 GET，而发送消息必须是 POST。
 * 页面用 fetch 读取响应体，并按空行把文本块拆开。因此这里每个事件都以两个换行结束。
 *
 * 已经启用的事件：message.delta、done、error、trace、tool、status、file.saved。
 * trace 只把调试步骤送到浏览器控制台。页面不展示，也不写入对话。
 * status 和 tool 组成过程条，结束时写入助手行的 process。file.saved 带上可下载的文件编号。
 * 后面才会出现的事件名先不在这里发送：citation、interrupt。
 */

export function encodeServerSentEvent(eventName: string, payload: Record<string, string>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function encodeDeltaEvent(deltaText: string): string {
  return encodeServerSentEvent("message.delta", { delta: deltaText });
}

export function encodeDoneEvent(): string {
  return encodeServerSentEvent("done", { ok: "1" });
}

export function encodeErrorEvent(message: string): string {
  return encodeServerSentEvent("error", { message });
}

/** 调试步骤。detail 可以是对象，页面只把它打到控制台。 */
export function encodeTraceEvent(step: string, detail: unknown): string {
  return `event: trace\ndata: ${JSON.stringify({ step, detail })}\n\n`;
}

export function encodeStatusEvent(id: string, state: string, title: string, detail: string): string {
  return encodeServerSentEvent("status", { id, state, title, detail });
}

export function encodeToolEvent(id: string, phase: string, name: string, detail: string): string {
  return encodeServerSentEvent("tool", { id, phase, name, detail });
}

export function encodeFileSavedEvent(fileId: string, title: string, bytes: number): string {
  return encodeServerSentEvent("file.saved", { fileId, title, bytes: String(bytes) });
}
