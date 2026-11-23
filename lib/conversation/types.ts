/** 页面和接口共用的字段。访客编号只留在服务端 Cookie 里，不出现在这些字段中。 */

export type ConversationRole = "user" | "assistant";

/** 助手气泡上的一步。running 只在生成过程中出现，不写入 process 列。 */
export type ProcessStepState = "running" | "done" | "failed" | "stopped";

export interface ProcessStep {
  id: string;
  state: ProcessStepState;
  title: string;
  detail: string;
}

export interface ConversationMessage {
  id: number;
  role: ConversationRole;
  content: string;
  createdAt: string;
  /** 用户消息始终是 null。助手消息没有可展示的步骤时也是 null。 */
  process: ProcessStep[] | null;
}

export interface ConversationHistory {
  messages: ConversationMessage[];
}

export interface MessageDeltaData {
  delta: string;
}

export interface StreamDoneData {
  ok: string;
}

export interface StreamErrorData {
  message: string;
}

/** 服务端调试步骤。只出现在浏览器控制台，不进入聊天记录。 */
export interface StreamTraceData {
  step: string;
  detail?: unknown;
}

export interface StreamToolData {
  id: string;
  phase: string;
  name: string;
  detail: string;
}

export interface StreamStatusData {
  id: string;
  state: string;
  title: string;
  detail: string;
}

export interface StreamFileData {
  fileId: string;
  title: string;
  bytes: string;
}

export interface ExportLink {
  fileId: string;
  title: string;
}

export interface VisibleMessage {
  localKey: string;
  role: ConversationRole;
  content: string;
  /** 正在生成的那一条。历史里的消息没有这个标记，过程条默认收起。 */
  live?: boolean;
  process?: ProcessStep[];
  exports?: ExportLink[];
}
