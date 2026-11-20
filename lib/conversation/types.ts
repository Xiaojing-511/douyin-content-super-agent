/** 页面和接口共用的字段。threadId 只是服务端那一个固定会话的编号。 */

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  id: number;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

export interface ConversationHistory {
  threadId: string;
  messages: ConversationMessage[];
}

export interface MessageDeltaData {
  delta: string;
}

export interface StreamDoneData {
  threadId: string;
}

export interface StreamErrorData {
  message: string;
}

/** 服务端调试步骤。只出现在浏览器控制台，不进入聊天记录。 */
export interface StreamTraceData {
  step: string;
  detail?: unknown;
}

export interface VisibleMessage {
  localKey: string;
  role: ConversationRole;
  content: string;
}
