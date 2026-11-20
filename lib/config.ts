import "server-only";

import path from "node:path";

/**
 * 这里读取会改变当前对话的值：数据库地址、日志级别、固定会话编号、主模型，以及联网搜索和 PDF。
 * 小模型和外部 PDF 命令留在环境文件里，这里还不读取。
 * 嵌入模型和重排模型由 lib/knowledge/settings.ts 在灌库和检索时读取。
 * 重排三项都留空时，检索只按向量距离排序。
 * 模型三项可以留空。留空时发送会返回明确错误，已保存的历史仍然可以打开。
 * 搜索密钥留空时，打开联网开关也不会打到千帆，模型会被告知这一轮不能联网。
 */

function databaseUrlFromEnvironment(): string {
  const configuredUrl =
    process.env.DATABASE_URL ?? "postgresql://advisor:advisor@localhost:5432/advisor";
  return configuredUrl.replace(/^postgres(ql)?\+asyncpg:\/\//, "postgresql://");
}

export const config = {
  databaseUrl: databaseUrlFromEnvironment(),
  logLevel: (process.env.LOG_LEVEL ?? "INFO").toUpperCase(),
  fixedThreadId: process.env.FIXED_THREAD_ID ?? "single-advisor-session",
  llmBaseUrl: (process.env.LLM_BASE_URL ?? "").trim(),
  llmApiKey: (process.env.LLM_API_KEY ?? "").trim(),
  llmModel: (process.env.LLM_MODEL ?? "").trim(),
  searchBaseUrl: (process.env.SEARCH_BASE_URL ?? "https://qianfan.baidubce.com").trim().replace(/\/$/, ""),
  searchApiKey: (process.env.SEARCH_API_KEY ?? "").trim(),
  exportRoot: path.join(process.cwd(), "data", "exports"),
  pdfFontPath: (process.env.PDF_FONT_PATH ?? "").trim(),
  pdfFontFamily: (process.env.PDF_FONT_FAMILY ?? "").trim(),
};

export function missingModelSettingNames(): string[] {
  const missing: string[] = [];
  if (!config.llmBaseUrl) {
    missing.push("LLM_BASE_URL");
  }
  if (!config.llmApiKey) {
    missing.push("LLM_API_KEY");
  }
  if (!config.llmModel) {
    missing.push("LLM_MODEL");
  }
  return missing;
}

export function databaseUrlForLog(databaseUrl: string): string {
  const schemeSeparator = "://";
  if (!databaseUrl.includes(schemeSeparator) || !databaseUrl.includes("@")) {
    return databaseUrl;
  }
  const [scheme, remainder] = databaseUrl.split(schemeSeparator, 2);
  const atIndex = remainder.lastIndexOf("@");
  const credentials = remainder.slice(0, atIndex);
  const hostAndDatabase = remainder.slice(atIndex + 1);
  const userName = credentials.split(":", 1)[0];
  return `${scheme}${schemeSeparator}${userName}:***@${hostAndDatabase}`;
}
