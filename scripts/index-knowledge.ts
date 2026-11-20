import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { chunkMarkdownDocument } from "../lib/knowledge/chunk-markdown";
import { redactSecret } from "../lib/knowledge/embed";
import { indexKnowledgeChunks } from "../lib/knowledge/index-library";
import { ensureKnowledgeSchema } from "../lib/knowledge/schema";
import {
  missingEmbeddingSettingNames,
  readDatabaseUrl,
  readEmbeddingSettings,
} from "../lib/knowledge/settings";
import { loadLocalEnvFiles } from "./load-env";

/**
 * 把 rag 目录里的 Markdown 切分、嵌入，并写入 knowledge_chunks。
 * 执行：npm run index-knowledge
 * 对话请求不会跑这条路径。改完文档后需要再执行一次，没变的片段不会重新嵌入。
 */

const KNOWLEDGE_DIRECTORY = "rag";

async function main(): Promise<void> {
  loadLocalEnvFiles();

  const missing = missingEmbeddingSettingNames();
  if (missing.length > 0) {
    throw new Error(`还没有配置嵌入模型。请在 .env 填写 ${missing.join("、")}，然后重新执行 npm run index-knowledge。`);
  }
  const settings = readEmbeddingSettings();
  if (!settings) {
    throw new Error("还没有配置嵌入模型。");
  }

  const files = listMarkdownFiles(path.join(process.cwd(), KNOWLEDGE_DIRECTORY));
  const chunks = files.flatMap((file) => {
    const sourcePath = path.relative(process.cwd(), file).split(path.sep).join("/");
    return chunkMarkdownDocument({
      sourcePath,
      markdown: readFileSync(file, "utf8"),
    });
  });
  if (chunks.length === 0) {
    console.log(`${KNOWLEDGE_DIRECTORY} 目录里没有可索引的 Markdown，没有写入向量。`);
    return;
  }

  const sql = postgres(readDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await ensureKnowledgeSchema(sql, settings.dimensions);
    const summary = await indexKnowledgeChunks(sql, settings, chunks);
    for (const change of summary.changes) {
      const label = change.action === "embed" ? "嵌入" : change.action === "skip" ? "跳过" : "删除";
      const heading = change.headingPath ? ` ${change.headingPath}` : "";
      console.log(`${label} ${change.sourcePath} #${change.chunkIndex}${heading}`);
    }
    console.log(
      [
        "知识库已写入",
        `文件 ${files.length}`,
        `片段 ${summary.chunkCount}`,
        `新嵌入 ${summary.embeddedCount}`,
        `未改动 ${summary.unchangedCount}`,
        `删除 ${summary.removedCount}`,
      ].join("\n"),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function listMarkdownFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      throw new Error(`找不到 ${KNOWLEDGE_DIRECTORY} 目录。`);
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "zh"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "知识库处理失败";
  const apiKey = (process.env.EMBEDDING_API_KEY ?? "").trim();
  console.error(redactSecret(message, apiKey));
  process.exitCode = 1;
});
