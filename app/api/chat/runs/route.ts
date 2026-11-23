import { config, missingModelSettingNames } from "@/lib/config";
import { ensureAdvisorGraph, iterAdvisorDeltas } from "@/lib/graph/advisor";
import { beginActiveChatRun, endActiveChatRun } from "@/lib/conversation/active-run";
import { openVisitor, withVisitorCookie } from "@/lib/conversation/visitor";
import { processToStore, stepFromTool, upsertProcessStep } from "@/lib/conversation/process";
import { appendCompletedTurn, listMessages } from "@/lib/conversation/repository";
import { exportMarkerLine, type ExportLink } from "@/lib/exports/marker";
import {
  encodeDeltaEvent,
  encodeDoneEvent,
  encodeErrorEvent,
  encodeFileSavedEvent,
  encodeStatusEvent,
  encodeToolEvent,
  encodeTraceEvent,
} from "@/lib/conversation/sse";
import type { ProcessStep } from "@/lib/conversation/types";
import { ensureConversationSchema } from "@/lib/db/client";
import { KnowledgeRetrievalError } from "@/lib/knowledge/errors";
import { logError, logStep, previewText, redactSecrets, type LogDetails } from "@/lib/logging";

/**
 * 接收一句新的用户原文，用模型逐段推送。
 * 全部推完后写入数据库。用户停止或浏览器断开时，把已经推到页面上的半截回复也写入。
 * 一个字都还没推出去就停的，不写库。
 * 模型未配置时只发 error，不调用模型，也不写库。历史接口不依赖这三项配置。
 * 每一步另发 trace，浏览器控制台能看到请求和检索内容。trace 不写入对话。
 * status 和 tool 收成过程条，和正文一起写入助手行的 process。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_LENGTH = 4000;

const STREAM_RESPONSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

type PersistResult = "saved" | "empty" | "failed";

export async function POST(request: Request) {
  const visitor = openVisitor(request);
  const threadId = visitor.threadId;
  const chatRequest = await readChatRequest(request);
  if (chatRequest instanceof Response) {
    logStep("对话请求没有通过校验");
    return withVisitorCookie(chatRequest, visitor);
  }
  const { userText, webSearch } = chatRequest;

  const encoder = new TextEncoder();
  const stopController = new AbortController();
  const stopThisRun = () => stopController.abort();
  if (!beginActiveChatRun(threadId, stopThisRun)) {
    logStep("上一轮还在生成", { 会话: threadId });
    return withVisitorCookie(Response.json({ detail: "上一轮还在生成" }, { status: 409 }), visitor);
  }
  const stopWhenRequestEnds = () => stopController.abort();
  request.signal.addEventListener("abort", stopWhenRequestEnds);
  if (request.signal.aborted) {
    stopWhenRequestEnds();
  }

  const stream = new ReadableStream({
    async start(controller) {
      const assistantParts: string[] = [];
      const savedFiles: ExportLink[] = [];
      let processSteps: ProcessStep[] = [];
      let exportMarkersAdded = false;
      let phase: "prepare" | "model" | "persist" = "prepare";
      let finished = false;
      let persistTask: Promise<PersistResult> | null = null;

      const appendExportMarkers = (): void => {
        if (exportMarkersAdded || savedFiles.length === 0 || assistantParts.join("").length === 0) {
          return;
        }
        exportMarkersAdded = true;
        for (const file of savedFiles) {
          const delta = exportMarkerLine(file);
          assistantParts.push(delta);
          enqueue(controller, encoder.encode(encodeDeltaEvent(delta)));
        }
      };

      const pushTrace = (step: string, summary?: LogDetails, detail?: unknown): void => {
        logStep(step, summary, detail);
        const payload = detail === undefined ? (summary ?? null) : detail;
        enqueue(controller, encoder.encode(redactSecrets(encodeTraceEvent(step, payload))));
      };

      pushTrace(
        "收到对话请求",
        {
          会话: threadId,
          用户字数: Array.from(userText).length,
          预览: previewText(userText, 40),
          模型: config.llmModel || "未配置",
          允许联网: webSearch,
        },
        { 会话: threadId, 内容: userText, 允许联网: webSearch },
      );

      const persistVisibleTurn = (): Promise<PersistResult> => {
        if (persistTask) {
          return persistTask;
        }
        persistTask = (async () => {
          appendExportMarkers();
          const assistantText = assistantParts.join("");
          if (!assistantText) {
            return "empty";
          }
          phase = "persist";
          try {
            pushTrace(
              "开始把本轮写入数据库",
              {
                会话: threadId,
                是否提前停止: stopController.signal.aborted,
                回复字数: Array.from(assistantText).length,
              },
              {
                是否提前停止: stopController.signal.aborted,
                用户: userText,
                回复: assistantText,
              },
            );
            await appendCompletedTurn(
              threadId,
              userText,
              assistantText,
              processToStore(processSteps, stopController.signal.aborted),
            );
            return "saved";
          } catch (error: unknown) {
            const reason = errorText(error);
            logError("本轮写入数据库失败", {
              会话: threadId,
              增量段数: assistantParts.length,
              原因: reason,
            });
            pushTrace("本轮写入数据库失败", { 增量段数: assistantParts.length }, { 原因: reason });
            return "failed";
          }
        })();
        return persistTask;
      };

      const finishStopped = async (): Promise<void> => {
        if (finished) {
          return;
        }
        finished = true;
        const result = await persistVisibleTurn();
        const clientGone = request.signal.aborted;
        if (result === "saved") {
          pushTrace(
            clientGone ? "浏览器断开，已保存页面上看得到的回复" : "生成已停止，已保存页面上看得到的回复",
            {
              会话: threadId,
              增量段数: assistantParts.length,
              回复字数: Array.from(assistantParts.join("")).length,
            },
          );
          if (!clientGone) {
            enqueue(controller, encoder.encode(encodeDoneEvent()));
          }
        } else if (result === "failed") {
          if (!clientGone) {
            enqueue(
              controller,
              encoder.encode(
                encodeErrorEvent("已停止生成，但这一轮没有保存。请确认数据库已启动，然后重试。"),
              ),
            );
          }
        } else {
          pushTrace("生成在出现文字前就停了，这一轮不保存", { 会话: threadId });
        }
        closeQuietly(controller);
      };

      try {
        if (stopController.signal.aborted) {
          await finishStopped();
          return;
        }

        const missingSettings = missingModelSettingNames();
        if (missingSettings.length > 0) {
          pushTrace("模型还没配置，本轮不会调用模型", { 缺少: missingSettings.join("、") });
          enqueue(
            controller,
            encoder.encode(
              encodeErrorEvent(`还没有配置模型。请在 .env 填写 ${missingSettings.join("、")}。`),
            ),
          );
          closeQuietly(controller);
          return;
        }

        await ensureConversationSchema();
        await ensureAdvisorGraph();
        pushTrace("开始读取已保存的历史", { 会话: threadId });
        const history = await listMessages(threadId);
        pushTrace(
          "已读取历史，准备检索和回复",
          { 条数: history.length },
          {
            消息: history.map((message) => ({
              角色: message.role === "user" ? "用户" : "顾问",
              内容: message.content,
            })),
          },
        );

        if (stopController.signal.aborted) {
          await finishStopped();
          return;
        }

        phase = "model";
        pushTrace("开始运行顾问图", {
          历史条数: history.length,
          本轮字数: Array.from(userText).length,
        });
        for await (const event of iterAdvisorDeltas({
          history,
          userText,
          webSearch,
          threadId,
          signal: stopController.signal,
        })) {
          if (stopController.signal.aborted) {
            await finishStopped();
            return;
          }

          if (event.type === "trace") {
            if (
              !enqueue(controller, encoder.encode(redactSecrets(encodeTraceEvent(event.step, event.detail))))
            ) {
              await finishStopped();
              return;
            }
            continue;
          }

          if (event.type === "status") {
            processSteps = upsertProcessStep(processSteps, event.step);
            if (
              !enqueue(
                controller,
                encoder.encode(
                  encodeStatusEvent(event.step.id, event.step.state, event.step.title, event.step.detail),
                ),
              )
            ) {
              await finishStopped();
              return;
            }
            continue;
          }

          if (event.type === "tool") {
            processSteps = upsertProcessStep(processSteps, stepFromTool(event));
            if (
              !enqueue(
                controller,
                encoder.encode(encodeToolEvent(event.id, event.phase, event.name, event.detail)),
              )
            ) {
              await finishStopped();
              return;
            }
            continue;
          }

          if (event.type === "file") {
            savedFiles.push({ fileId: event.fileId, title: event.title });
            if (!enqueue(controller, encoder.encode(encodeFileSavedEvent(event.fileId, event.title, event.bytes)))) {
              await finishStopped();
              return;
            }
            continue;
          }

          assistantParts.push(event.delta);
          if (!enqueue(controller, encoder.encode(encodeDeltaEvent(event.delta)))) {
            await finishStopped();
            return;
          }
        }

        if (stopController.signal.aborted) {
          await finishStopped();
          return;
        }

        finished = true;
        const result = await persistVisibleTurn();
        if (result === "empty") {
          pushTrace("模型没有返回内容，这一轮不保存");
          enqueue(controller, encoder.encode(encodeErrorEvent("这一轮没有保存。模型没有返回内容。")));
          closeQuietly(controller);
          return;
        }
        if (result === "failed") {
          enqueue(
            controller,
            encoder.encode(encodeErrorEvent("这一轮没有保存。请确认数据库已启动，然后重试。")),
          );
          closeQuietly(controller);
          return;
        }

        pushTrace(stopController.signal.aborted ? "生成已停止，已保存页面上看得到的回复" : "本轮完成", {
          会话: threadId,
          增量段数: assistantParts.length,
          回复字数: Array.from(assistantParts.join("")).length,
        });
        if (!request.signal.aborted) {
          enqueue(controller, encoder.encode(encodeDoneEvent()));
        }
        closeQuietly(controller);
      } catch (error: unknown) {
        if (finished) {
          closeQuietly(controller);
          return;
        }
        if (stopController.signal.aborted || isAbortError(error)) {
          await finishStopped();
          return;
        }

        const knowledgeError = findKnowledgeRetrievalError(error);
        const reason = knowledgeError ? knowledgeError.detail : errorText(error);
        logError("本轮失败", {
          会话: threadId,
          阶段: phaseLabel(phase),
          增量段数: assistantParts.length,
          原因: reason,
        });
        pushTrace("本轮失败", { 阶段: phaseLabel(phase), 增量段数: assistantParts.length }, { 原因: reason });
        enqueue(controller, encoder.encode(encodeErrorEvent(publicErrorMessage(phase, error))));
        closeQuietly(controller);
      } finally {
        endActiveChatRun(threadId, stopThisRun);
        request.signal.removeEventListener("abort", stopWhenRequestEnds);
      }
    },
    cancel() {
      stopThisRun();
    },
  });

  const headers = new Headers(STREAM_RESPONSE_HEADERS);
  if (visitor.setCookie) {
    headers.append("Set-Cookie", visitor.setCookie);
  }
  return new Response(stream, { headers });
}

function phaseLabel(phase: "prepare" | "model" | "persist"): string {
  if (phase === "model") {
    return "调用模型";
  }
  if (phase === "persist") {
    return "保存对话";
  }
  return "准备";
}

function publicErrorMessage(phase: "prepare" | "model" | "persist", error: unknown): string {
  const knowledgeError = findKnowledgeRetrievalError(error);
  if (knowledgeError) {
    if (knowledgeError.detail.includes("重排")) {
      return "这一轮没有保存。知识库重排失败，请检查 RERANK_BASE_URL、RERANK_API_KEY 和 RERANK_MODEL。";
    }
    return "这一轮没有保存。知识库检索失败，请检查 EMBEDDING_BASE_URL、EMBEDDING_API_KEY、EMBEDDING_MODEL 和数据库。";
  }
  if (phase === "model") {
    if (error instanceof Error && error.message === "模型没有返回内容") {
      return "这一轮没有保存。模型没有返回内容。";
    }
    return "这一轮没有保存。模型没有完成回复，请检查 LLM_BASE_URL、LLM_API_KEY 和 LLM_MODEL。";
  }
  return "这一轮没有保存。请确认数据库已启动，然后重试。";
}

function errorText(error: unknown): string {
  let message = error instanceof Error ? error.message : "unknown";
  for (const secret of [
    config.llmApiKey,
    config.searchApiKey,
    (process.env.EMBEDDING_API_KEY ?? "").trim(),
    (process.env.RERANK_API_KEY ?? "").trim(),
  ]) {
    if (secret) {
      message = message.split(secret).join("***");
    }
  }
  return message;
}

function findKnowledgeRetrievalError(error: unknown): KnowledgeRetrievalError | null {
  if (error instanceof KnowledgeRetrievalError) {
    return error;
  }
  if (error instanceof Error && error.cause) {
    return findKnowledgeRetrievalError(error.cause);
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readChatRequest(request: Request): Promise<{ userText: string; webSearch: boolean } | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: "消息不能为空" }, { status: 422 });
  }

  const content =
    typeof body === "object" && body !== null && "content" in body
      ? (body as { content: unknown }).content
      : undefined;
  if (typeof content !== "string" || content.length === 0) {
    return Response.json({ detail: "消息不能为空" }, { status: 422 });
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return Response.json({ detail: "消息过长" }, { status: 422 });
  }

  const userText = content.trim();
  if (!userText) {
    return Response.json({ detail: "消息不能为空" }, { status: 422 });
  }
  const webSearch =
    typeof body === "object" && body !== null && "webSearch" in body
      ? (body as { webSearch: unknown }).webSearch === true
      : false;
  return { userText, webSearch };
}

function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): boolean {
  try {
    controller.enqueue(bytes);
    return true;
  } catch {
    return false;
  }
}

function closeQuietly(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // 客户端已经断开时，关闭流会再次抛出。已经展示的回复会在关闭前写入；还没展示出字就停的，库里没有这一轮。
  }
}
