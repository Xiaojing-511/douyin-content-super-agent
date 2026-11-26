import "server-only";

import type { RunnableConfig } from "@langchain/core/runnables";
import { traceable } from "langsmith/traceable";

import { getSqlClient } from "@/lib/db/client";
import type { RetrievedChunk } from "@/lib/knowledge/context";
import { embedTexts, redactSecret, toVectorLiteral } from "@/lib/knowledge/embed";
import { KnowledgeRetrievalError } from "@/lib/knowledge/errors";
import { rerankTexts, type RerankHit } from "@/lib/knowledge/rerank";
import { ensureKnowledgeSchema } from "@/lib/knowledge/schema";
import { readEmbeddingSettings, readRerankSettings, type EmbeddingSettings, type RerankSettings } from "@/lib/knowledge/settings";
import { embeddingInput, type KnowledgeSource } from "@/lib/knowledge/chunk-markdown";
import { invokeTraced } from "@/lib/graph/tracing";
import { logStep, previewText, type LogDetails } from "@/lib/logging";

/**
 * 对话里只做查询：把这一轮的检索问句变成向量，按余弦距离取候选片段。
 * 重排三项都配齐时，再把这 6 段交给 /rerank，按相关分留下 3 段放进提示。
 * 切分和嵌入在 npm run index-knowledge 里完成。知识库还是空的时候，不调用嵌入接口。
 * 嵌入、向量召回和重排都会打出中文步骤，并带上这一步的请求和片段原文。
 * 追踪打开时，这三步再各记一条 LangSmith 子 run。向量和重排正文不上传，只上传维度、标题路径和分数。
 */

export type KnowledgeTrace = (step: string, summary?: LogDetails, detail?: unknown) => void;

const RECALL_LIMIT = 6;
const RERANKED_PROMPT_LIMIT = 3;

type ChunkRow = {
  doc_title: string;
  doc_type: string;
  heading_path: string;
  content: string;
  sources: unknown;
  distance: number | string;
};

export async function searchKnowledge(
  query: string,
  signal?: AbortSignal,
  trace?: KnowledgeTrace,
  runConfig?: RunnableConfig,
): Promise<RetrievedChunk[]> {
  const settings = readEmbeddingSettings();
  if (!settings || !query.trim()) {
    emit(
      trace,
      settings ? "检索问句是空的，跳过知识库检索" : "没有配置嵌入模型，跳过知识库检索",
    );
    return [];
  }
  if (signal?.aborted) {
    throw new DOMException("模型回复已取消", "AbortError");
  }

  const apiKey = settings.apiKey;
  let step = "检查知识库";
  try {
    const sql = getSqlClient();
    emit(trace, "确认知识库里是否已有片段", { 向量维度: settings.dimensions });
    await ensureKnowledgeSchema(sql, settings.dimensions);
    const filled = await sql<{ filled: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM knowledge_chunks) AS filled
    `;
    if (!filled[0]?.filled) {
      emit(trace, "知识库还是空的，跳过检索");
      return [];
    }

    step = "请求嵌入模型";
    emit(
      trace,
      "开始请求嵌入模型",
      {
        模型: settings.model,
        问句字数: Array.from(query).length,
        预览: previewText(query, 40),
      },
      { 接口: settings.baseUrl, 模型: settings.model, 输入: query },
    );
    const embedding = await embedQuery(query, settings, signal, runConfig);
    emit(trace, "嵌入完成", { 模型: settings.model, 维度: embedding.length });

    step = "向量检索";
    emit(trace, "开始向量检索", {
      说明: "按余弦距离取近邻，同一标题只留最近的一段",
      先取行数: RECALL_LIMIT * 2,
      去重后最多保留: RECALL_LIMIT,
    });
    const literal = toVectorLiteral(embedding);
    const recalled = await recallChunks(sql, literal, runConfig);
    const candidates = recalled.chunks;
    emit(
      trace,
      "向量召回完成",
      { 原始行数: recalled.rowCount, 去重后条数: candidates.length },
      { 片段: candidates.map(describeChunk) },
    );

    step = "读取重排配置";
    const rerankSettings = readRerankSettings();
    if (!rerankSettings || candidates.length < 2) {
      const reason = !rerankSettings ? "没有配置重排，按向量距离保留" : "候选不足两条，不调用重排";
      emit(trace, reason, { 保留条数: candidates.length });
      return candidates.slice(0, RECALL_LIMIT);
    }

    step = "重排";
    const documents = candidates.map((chunk) => embeddingInput(chunk));
    emit(
      trace,
      "开始重排",
      {
        模型: rerankSettings.model,
        候选条数: documents.length,
        保留条数: RERANKED_PROMPT_LIMIT,
      },
      {
        接口: rerankSettings.baseUrl,
        模型: rerankSettings.model,
        问句: query,
        保留条数: RERANKED_PROMPT_LIMIT,
        文档: documents,
      },
    );
    const ranked = await rerankCandidates(query, documents, candidates, rerankSettings, signal, runConfig);
    const selected = ranked.map((hit) => {
      const chunk = candidates[hit.index];
      if (!chunk) {
        throw new Error("重排结果指向了不存在的候选片段");
      }
      return { ...chunk, rerankScore: hit.score };
    });
    emit(trace, "重排完成", { 保留条数: selected.length }, { 结果: selected.map(describeChunk) });
    return selected;
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    const message = redactRetrievalSecrets(errorText(error), apiKey);
    emit(trace, "知识库检索失败", { 停在: step }, { 停在: step, 原因: message });
    throw new KnowledgeRetrievalError(`${step}：${message}`);
  }
}

async function embedQuery(
  query: string,
  settings: EmbeddingSettings,
  signal: AbortSignal | undefined,
  runConfig: RunnableConfig | undefined,
): Promise<number[]> {
  const traced = traceable(
    async (input: { query: string }) => {
      const [vector] = await embedTexts([input.query], settings, signal);
      if (!vector) {
        throw new Error("嵌入接口没有返回向量");
      }
      return { dimensions: vector.length, vector };
    },
    {
      name: "embed_query",
      run_type: "embedding",
      metadata: { model: settings.model },
      processOutputs: (outputs) => ({ dimensions: outputs.dimensions }),
    },
  );
  const embedded = await invokeTraced(runConfig, traced, { query });
  return embedded.vector;
}

async function recallChunks(
  sql: ReturnType<typeof getSqlClient>,
  literal: string,
  runConfig: RunnableConfig | undefined,
): Promise<{ rowCount: number; chunks: RetrievedChunk[] }> {
  const traced = traceable(
    async (input: { limit: number }) => {
      const rows = await sql<ChunkRow[]>`
        SELECT
          doc_title,
          doc_type,
          heading_path,
          content,
          sources,
          embedding <=> ${literal}::vector AS distance
        FROM knowledge_chunks
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${input.limit * 2}
      `;
      const chunks = nearestDistinctHeadings(rows, input.limit);
      return {
        rowCount: rows.length,
        chunks,
        hits: chunks.map((chunk) => ({
          heading: chunk.headingPath,
          distance: Number(chunk.distance.toFixed(4)),
        })),
      };
    },
    {
      name: "vector_recall",
      run_type: "retriever",
      processInputs: (inputs) => ({ limit: inputs.limit }),
      processOutputs: (outputs) => ({ rowCount: outputs.rowCount, hits: outputs.hits }),
    },
  );
  const recalled = await invokeTraced(runConfig, traced, { limit: RECALL_LIMIT });
  return { rowCount: recalled.rowCount, chunks: recalled.chunks };
}

async function rerankCandidates(
  query: string,
  documents: string[],
  candidates: RetrievedChunk[],
  settings: RerankSettings,
  signal: AbortSignal | undefined,
  runConfig: RunnableConfig | undefined,
): Promise<RerankHit[]> {
  const traced = traceable(
    async (input: { query: string; headings: string[] }) => {
      const hits = await rerankTexts(input.query, documents, settings, RERANKED_PROMPT_LIMIT, signal);
      return {
        hits,
        scores: hits.map((hit) => ({
          heading: candidates[hit.index]?.headingPath ?? "",
          score: Number(hit.score.toFixed(4)),
        })),
      };
    },
    {
      name: "rerank",
      run_type: "retriever",
      metadata: { model: settings.model, keep: RERANKED_PROMPT_LIMIT },
      processInputs: (inputs) => ({
        query: inputs.query,
        headings: inputs.headings,
        keep: RERANKED_PROMPT_LIMIT,
      }),
      processOutputs: (outputs) => ({ scores: outputs.scores }),
    },
  );
  const ranked = await invokeTraced(runConfig, traced, {
    query,
    headings: candidates.map((chunk) => chunk.headingPath),
  });
  return ranked.hits;
}

function emit(trace: KnowledgeTrace | undefined, step: string, summary?: LogDetails, detail?: unknown): void {
  if (trace) {
    trace(step, summary, detail);
    return;
  }
  logStep(step, summary, detail);
}

function describeChunk(chunk: RetrievedChunk): {
  文档类型: string;
  标题路径: string;
  向量距离: number;
  重排分: number | null;
  内容: string;
  出处: string[];
} {
  return {
    文档类型: chunk.docType,
    标题路径: chunk.headingPath,
    向量距离: roundScore(chunk.distance),
    重排分: chunk.rerankScore === undefined ? null : roundScore(chunk.rerankScore),
    内容: chunk.content,
    出处: chunk.sources.map((source) => source.title),
  };
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}

function nearestDistinctHeadings(rows: ChunkRow[], limit: number): RetrievedChunk[] {
  const seen = new Set<string>();
  const chunks: RetrievedChunk[] = [];
  for (const row of rows) {
    if (seen.has(row.heading_path)) {
      continue;
    }
    seen.add(row.heading_path);
    chunks.push({
      docTitle: row.doc_title,
      docType: row.doc_type,
      headingPath: row.heading_path,
      content: row.content,
      sources: readSources(row.sources),
      distance: Number(row.distance),
    });
    if (chunks.length >= limit) {
      break;
    }
  }
  return chunks;
}

function readSources(value: unknown): KnowledgeSource[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const title = "title" in item ? item.title : undefined;
    const url = "url" in item ? item.url : undefined;
    if (typeof title !== "string" || typeof url !== "string") {
      return [];
    }
    return [{ title, url }];
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function redactRetrievalSecrets(text: string, embeddingKey: string): string {
  const rerankKey = (process.env.RERANK_API_KEY ?? "").trim();
  return redactSecret(redactSecret(text, embeddingKey), rerankKey);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "知识库检索失败";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
