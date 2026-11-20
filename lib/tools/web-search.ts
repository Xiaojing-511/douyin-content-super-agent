import "server-only";

import { config } from "@/lib/config";
import { logStep, previewText } from "@/lib/logging";

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchOutcome =
  | { ok: true; results: WebSearchHit[] }
  | { ok: false; reason: string };

const RESULT_LIMIT = 3;
const SEARCH_TIMEOUT_MS = 12_000;
const SEARCH_PATH = "/v2/ai_search/web_search";

/**
 * 请求百度千帆的网页搜索。
 * 没配密钥、超时或接口失败时返回原因，不把这一轮对话打成失败。
 * 用户停止时仍然抛出取消，让图停下来。
 * 请求、原始响应和保留下来的条目都会写入终端日志。DEBUG 才打印完整请求和响应。
 */
export async function searchWeb(
  query: string,
  signal: AbortSignal | undefined,
): Promise<WebSearchOutcome> {
  const cleanedQuery = query.replace(/\s+/g, " ").trim();
  if (!cleanedQuery) {
    logStep("检索问句是空的，跳过百度千帆搜索");
    return { ok: false, reason: "检索问句是空的。" };
  }
  if (!config.searchApiKey) {
    logStep("没有配置 SEARCH_API_KEY，跳过百度千帆搜索");
    return {
      ok: false,
      reason:
        "没有配置 SEARCH_API_KEY，这一轮不能联网。请直接根据已有资料回答，不要编造出处。",
    };
  }

  const content = Array.from(cleanedQuery).slice(0, 200).join("");
  const endpoint = `${config.searchBaseUrl}${SEARCH_PATH}`;
  const requestBody = {
    messages: [{ role: "user", content }],
    search_source: "baidu_search_v2",
    edition: "standard",
    resource_type_filter: [{ type: "web", top_k: RESULT_LIMIT }],
  };
  logStep(
    "开始请求百度千帆搜索",
    {
      接口: endpoint,
      问句字数: Array.from(content).length,
      预览: previewText(content, 40),
      版本: requestBody.edition,
      网页条数: RESULT_LIMIT,
      超时毫秒: SEARCH_TIMEOUT_MS,
    },
    { 接口: endpoint, 方法: "POST", 请求: requestBody },
  );

  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.searchApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: combined,
    });
  } catch (error: unknown) {
    const elapsed = Date.now() - startedAt;
    if (signal?.aborted) {
      logStep("百度千帆搜索已取消", { 耗时毫秒: elapsed });
      throw new DOMException("模型回复已取消", "AbortError");
    }
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    logStep(timedOut ? "百度千帆搜索超时" : "百度千帆搜索没有连上", {
      耗时毫秒: elapsed,
      超时毫秒: SEARCH_TIMEOUT_MS,
      原因: error instanceof Error ? previewText(error.message, 80) : "网络错误",
    });
    return {
      ok: false,
      reason: timedOut ? "联网搜索超时。" : "联网搜索没有连上。",
    };
  }

  const elapsed = Date.now() - startedAt;
  if (!response.ok) {
    const errorPayload = await readErrorPayload(response);
    const detail = readMessage(errorPayload);
    const reason = detail
      ? `联网搜索没有完成，状态码 ${response.status}：${detail}`
      : `联网搜索没有完成，状态码 ${response.status}。`;
    logStep(
      "百度千帆搜索没有完成",
      { 状态码: response.status, 耗时毫秒: elapsed, 原因: previewText(reason, 80) },
      { 状态码: response.status, 耗时毫秒: elapsed, 响应: errorPayload },
    );
    return { ok: false, reason };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    logStep("百度千帆搜索没有返回可解析的结果", {
      状态码: response.status,
      耗时毫秒: elapsed,
    });
    return { ok: false, reason: "联网搜索没有返回可解析的结果。" };
  }

  const requestId = readRequestId(payload);
  logStep(
    "百度千帆搜索已返回",
    {
      状态码: response.status,
      耗时毫秒: elapsed,
      引用条数: countReferences(payload),
      ...(requestId ? { 请求编号: requestId } : {}),
    },
    { 状态码: response.status, 耗时毫秒: elapsed, 响应: payload },
  );

  const failure = readApiFailure(payload);
  if (failure) {
    logStep("百度千帆搜索返回错误", {
      耗时毫秒: elapsed,
      原因: previewText(failure, 80),
      ...(requestId ? { 请求编号: requestId } : {}),
    });
    return { ok: false, reason: failure };
  }

  const results = readHits(payload);
  logStep(
    "百度千帆搜索完成",
    {
      保留条数: results.length,
      耗时毫秒: elapsed,
      标题: previewText(results.map((hit) => hit.title).join(" | "), 80) || "无",
      ...(requestId ? { 请求编号: requestId } : {}),
    },
    {
      结果: results.map((hit) => ({ 标题: hit.title, 链接: hit.url, 摘录: hit.snippet })),
    },
  );
  return { ok: true, results };
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readRequestId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("request_id" in payload)) {
    return "";
  }
  const requestId = (payload as { request_id?: unknown }).request_id;
  return typeof requestId === "string" ? requestId : "";
}

function countReferences(payload: unknown): number {
  if (typeof payload !== "object" || payload === null || !("references" in payload)) {
    return 0;
  }
  const references = (payload as { references?: unknown }).references;
  return Array.isArray(references) ? references.length : 0;
}

function readApiFailure(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const record = payload as { code?: unknown; references?: unknown };
  if (
    Array.isArray(record.references) ||
    record.code === undefined ||
    record.code === null ||
    record.code === ""
  ) {
    return "";
  }
  const message = readMessage(payload);
  return message ? `联网搜索没有完成：${message}` : "联网搜索没有完成。";
}

function readMessage(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("message" in payload)
  ) {
    return "";
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? clip(message, 80) : "";
}

function readHits(payload: unknown): WebSearchHit[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("references" in payload)
  ) {
    return [];
  }
  const references = (payload as { references?: unknown }).references;
  if (!Array.isArray(references)) {
    return [];
  }
  const hits: WebSearchHit[] = [];
  for (const item of references) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as {
      title?: unknown;
      url?: unknown;
      content?: unknown;
      snippet?: unknown;
      type?: unknown;
    };
    if (typeof record.type === "string" && record.type !== "web") {
      continue;
    }
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      continue;
    }
    const excerpt =
      typeof record.snippet === "string" && record.snippet.trim()
        ? record.snippet
        : typeof record.content === "string"
          ? record.content
          : "";
    hits.push({
      title: clip(typeof record.title === "string" ? record.title : url, 80),
      url,
      snippet: clip(excerpt, 320),
    });
    if (hits.length >= RESULT_LIMIT) {
      break;
    }
  }
  return hits;
}

function clip(value: string, characterLimit: number): string {
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(cleaned);
  if (characters.length <= characterLimit) {
    return cleaned;
  }
  return `${characters.slice(0, characterLimit).join("")}…`;
}
