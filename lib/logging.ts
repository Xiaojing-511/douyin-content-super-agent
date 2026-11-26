import "server-only";

import { config } from "@/lib/config";

/**
 * 终端里的中文步骤日志。
 *
 * INFO 记这一步在做什么，并带上很短的数字或预览。
 * DEBUG 才把这一步的请求、检索片段和模型原文完整打出来。
 * 密钥若出现在文本里会被换成 ***。这些日志不离开本机。
 * 同一步的内容还会用 trace 事件送到浏览器控制台，页面本身不展示。
 */

const LEVEL_RANK: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

export type LogDetails = Record<string, string | number | boolean>;

function shouldWrite(level: string): boolean {
  const configuredRank = LEVEL_RANK[config.logLevel] ?? LEVEL_RANK.INFO;
  const messageRank = LEVEL_RANK[level] ?? LEVEL_RANK.INFO;
  return messageRank >= configuredRank;
}

function write(level: "INFO" | "ERROR", message: string, details?: LogDetails): void {
  if (!shouldWrite(level)) {
    return;
  }
  const detailText = details
    ? ` ${Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")}`
    : "";
  const line = redactSecrets(`${new Date().toISOString()} ${level} 顾问 ${message}${detailText}`);
  if (level === "ERROR") {
    console.error(line);
    return;
  }
  console.info(line);
}

export function logInfo(message: string, details?: LogDetails): void {
  write("INFO", message, details);
}

export function logError(message: string, details?: LogDetails): void {
  write("ERROR", message, details);
}

export function logDebug(message: string, details?: unknown): void {
  if (!shouldWrite("DEBUG")) {
    return;
  }
  const body = formatDebugDetails(details);
  console.info(redactSecrets(`${new Date().toISOString()} DEBUG 顾问 ${message}${body}`));
}

/** INFO 写步骤名，DEBUG 再写这一步的完整内容。 */
export function logStep(step: string, summary?: LogDetails, detail?: unknown): void {
  logInfo(step, summary);
  if (detail !== undefined) {
    logDebug(`${step}详情`, detail);
  }
}

function formatDebugDetails(details: unknown): string {
  if (details === undefined) {
    return "";
  }
  try {
    return `\n${redactSecrets(JSON.stringify(details, null, 2))}`;
  } catch {
    return "\n详情无法序列化";
  }
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const secret of [
    config.llmApiKey,
    config.searchApiKey,
    config.langsmithApiKey,
    (process.env.EMBEDDING_API_KEY ?? "").trim(),
    (process.env.RERANK_API_KEY ?? "").trim(),
  ]) {
    if (secret) {
      redacted = redacted.split(secret).join("***");
    }
  }
  return redacted;
}

export function previewText(text: string, characterLimit = 24): string {
  const compactText = text.split(/\s+/).join(" ");
  const characters = Array.from(compactText);
  if (characters.length <= characterLimit) {
    return compactText;
  }
  return `${characters.slice(0, characterLimit).join("")}…`;
}
