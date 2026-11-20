import "server-only";

import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { config } from "@/lib/config";
import type { ConversationMessage } from "@/lib/conversation/types";
import { getCheckpointer } from "@/lib/graph/checkpoint";
import { loadAdvisorSystemPrompt } from "@/lib/graph/load-system-prompt";
import { createChatModel } from "@/lib/graph/model";
import { buildSearchQuery, renderKnowledgeContext, type RetrievedChunk } from "@/lib/knowledge/context";
import { searchKnowledge, type KnowledgeTrace } from "@/lib/knowledge/search";
import { readEmbeddingSettings } from "@/lib/knowledge/settings";
import { logStep, previewText, type LogDetails } from "@/lib/logging";

/**
 * 回答前先检索知识库，再读系统提示并调用主模型。
 *
 * 消息状态使用替换而不是追加。每一轮开始时，用已经落库的历史覆盖图状态。
 * 召回的资料放在 knowledge，不写进 messages。它只在这一轮拼进系统提示。
 * 检索和模型请求会打出中文日志，并把同一步发给浏览器控制台。
 * 中止时路由会把已经推到页面上的半截回复写入消息表，下一轮因此能记住用户看过的内容。
 * 一个字都还没推出去就中止的，消息表里没有这一轮。
 * checkpoint 仍写入 Postgres，使用这一个固定 thread_id，供后面的人审恢复。
 */

const AdvisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  knowledge: Annotation<RetrievedChunk[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
});

type AdvisorGraph = ReturnType<typeof compileAdvisorGraph>;

const globalForAdvisor = globalThis as unknown as {
  advisorGraph?: AdvisorGraph;
};

async function retrieveNode(
  state: typeof AdvisorState.State,
  runConfig: LangGraphRunnableConfig,
): Promise<typeof AdvisorState.Update> {
  if (runConfig.signal?.aborted) {
    throw new DOMException("模型回复已取消", "AbortError");
  }
  const report: KnowledgeTrace = (step, summary, detail) => {
    reportTrace(runConfig, step, summary, detail);
  };
  if (!readEmbeddingSettings()) {
    report("没有配置嵌入模型，跳过知识库检索");
    return { knowledge: [] };
  }

  const query = buildSearchQuery(
    state.messages.filter((message) => message.getType() === "human").map((message) => message.text),
  );
  if (!query.trim()) {
    report("检索问句是空的，跳过知识库检索");
    return { knowledge: [] };
  }

  report(
    "开始知识库检索",
    { 问句字数: Array.from(query).length, 预览: previewText(query, 40) },
    { 检索问句: query },
  );
  const knowledge = await searchKnowledge(query, runConfig.signal, report);
  report(
    "这些片段会放进本轮提示",
    {
      条数: knowledge.length,
      经过重排: knowledge.some((chunk) => chunk.rerankScore !== undefined),
      标题: previewText(knowledge.map((chunk) => chunk.headingPath).join(" | "), 80),
    },
    { 片段: knowledge.map(describeRetrievedChunk) },
  );
  return { knowledge };
}

async function replyNode(
  state: typeof AdvisorState.State,
  runConfig: LangGraphRunnableConfig,
): Promise<typeof AdvisorState.Update> {
  const writer = runConfig.writer;
  if (!writer) {
    throw new Error("模型流没有接到页面");
  }

  const model = createChatModel();
  const knowledgeContext = renderKnowledgeContext(state.knowledge);
  const systemPrompt = knowledgeContext
    ? `${loadAdvisorSystemPrompt()}\n\n${knowledgeContext}`
    : loadAdvisorSystemPrompt();
  const promptMessages = [new SystemMessage(systemPrompt), ...state.messages];
  reportTrace(
    runConfig,
    "开始对话模型请求",
    {
      模型: config.llmModel,
      接口: config.llmBaseUrl,
      消息条数: promptMessages.length,
      资料条数: state.knowledge.length,
    },
    {
      接口: config.llmBaseUrl,
      模型: config.llmModel,
      消息: promptMessages.map(describeModelMessage),
    },
  );
  const modelStream = await model.stream(promptMessages, { signal: runConfig.signal });

  let assistantText = "";
  let loggedFirstToken = false;
  for await (const chunk of modelStream) {
    if (runConfig.signal?.aborted) {
      throw new DOMException("模型回复已取消", "AbortError");
    }
    const delta = chunk.text;
    if (!delta) {
      continue;
    }
    if (!loggedFirstToken) {
      loggedFirstToken = true;
      logStep("模型开始返回文字", { 模型: config.llmModel });
    }
    assistantText += delta;
    writer({ delta });
  }

  if (runConfig.signal?.aborted) {
    throw new DOMException("模型回复已取消", "AbortError");
  }
  if (!assistantText) {
    throw new Error("模型没有返回内容");
  }

  reportTrace(
    runConfig,
    "对话模型返回完成",
    { 字数: Array.from(assistantText).length },
    { 字数: Array.from(assistantText).length, 内容: assistantText },
  );

  return {
    messages: [...state.messages, new AIMessage({ content: assistantText })],
  };
}

function compileAdvisorGraph(checkpointer: Awaited<ReturnType<typeof getCheckpointer>>) {
  return new StateGraph(AdvisorState)
    .addNode("retrieve", retrieveNode)
    .addNode("reply", replyNode)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "reply")
    .addEdge("reply", END)
    .compile({ checkpointer });
}

export async function ensureAdvisorGraph(): Promise<void> {
  await getAdvisorGraph();
}

async function getAdvisorGraph(): Promise<AdvisorGraph> {
  if (process.env.NODE_ENV === "production" && globalForAdvisor.advisorGraph) {
    return globalForAdvisor.advisorGraph;
  }
  const graph = compileAdvisorGraph(await getCheckpointer());
  if (process.env.NODE_ENV === "production") {
    globalForAdvisor.advisorGraph = graph;
  }
  return graph;
}

export type AdvisorStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "trace"; step: string; detail?: unknown };

export async function* iterAdvisorDeltas(input: {
  history: ConversationMessage[];
  userText: string;
  signal: AbortSignal;
}): AsyncGenerator<AdvisorStreamEvent> {
  const graph = await getAdvisorGraph();
  const stream = await graph.stream(
    {
      messages: [...input.history.map(toLangChainMessage), new HumanMessage({ content: input.userText })],
    },
    {
      configurable: { thread_id: config.fixedThreadId },
      streamMode: "custom",
      signal: input.signal,
    },
  );

  for await (const chunk of stream) {
    if (input.signal.aborted) {
      throw new DOMException("模型回复已取消", "AbortError");
    }
    const event = readCustomChunk(chunk);
    if (event) {
      yield event;
    }
  }
}

function reportTrace(
  runConfig: LangGraphRunnableConfig,
  step: string,
  summary?: LogDetails,
  detail?: unknown,
): void {
  logStep(step, summary, detail);
  runConfig.writer?.({ trace: { step, detail: detail === undefined ? summary : detail } });
}

function describeRetrievedChunk(chunk: RetrievedChunk): {
  文档类型: string;
  标题路径: string;
  向量距离: number;
  重排分: number | null;
  内容: string;
} {
  return {
    文档类型: chunk.docType,
    标题路径: chunk.headingPath,
    向量距离: Number(chunk.distance.toFixed(4)),
    重排分: chunk.rerankScore === undefined ? null : Number(chunk.rerankScore.toFixed(4)),
    内容: chunk.content,
  };
}

function describeModelMessage(message: BaseMessage): { 角色: string; 内容: string } {
  const role =
    message.type === "system"
      ? "系统"
      : message.type === "human"
        ? "用户"
        : message.type === "ai"
          ? "顾问"
          : message.type;
  return {
    角色: role,
    内容: message.text,
  };
}

function toLangChainMessage(message: ConversationMessage): BaseMessage {
  if (message.role === "user") {
    return new HumanMessage({ content: message.content });
  }
  return new AIMessage({ content: message.content });
}

function readCustomChunk(chunk: unknown): AdvisorStreamEvent | null {
  if (typeof chunk !== "object" || chunk === null) {
    return null;
  }
  if ("trace" in chunk) {
    const trace = (chunk as { trace?: unknown }).trace;
    if (typeof trace === "object" && trace !== null && "step" in trace) {
      const step = (trace as { step?: unknown }).step;
      if (typeof step === "string") {
        const detail = "detail" in trace ? (trace as { detail?: unknown }).detail : undefined;
        return { type: "trace", step, detail };
      }
    }
  }
  if ("delta" in chunk && typeof (chunk as { delta?: unknown }).delta === "string") {
    const delta = (chunk as { delta: string }).delta;
    return delta ? { type: "delta", delta } : null;
  }
  return null;
}
