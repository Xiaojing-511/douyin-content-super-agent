import type postgres from "postgres";

import { embeddingInput, type KnowledgeChunkDraft } from "./chunk-markdown";
import { embedTexts, toVectorLiteral } from "./embed";
import type { EmbeddingSettings } from "./settings";

/**
 * 只嵌入哈希或嵌入模型变了的片段。
 * 先向嵌入接口拿完全部新向量，再在一个事务里删旧行、插新行。
 * 嵌入失败时表保持原样，下一次命令可以继续补。
 */

type Sql = postgres.Sql;

type ExistingChunk = {
  source_path: string;
  chunk_index: number;
  content_hash: string;
  embedding_model: string;
  heading_path: string;
};

export type IndexChange = {
  action: "embed" | "skip" | "delete";
  sourcePath: string;
  chunkIndex: number;
  headingPath: string;
};

export type IndexSummary = {
  chunkCount: number;
  embeddedCount: number;
  unchangedCount: number;
  removedCount: number;
  changes: IndexChange[];
};

export async function indexKnowledgeChunks(
  sql: Sql,
  settings: EmbeddingSettings,
  chunks: KnowledgeChunkDraft[],
): Promise<IndexSummary> {
  const existing = await sql<ExistingChunk[]>`
    SELECT source_path, chunk_index, content_hash, embedding_model, heading_path
    FROM knowledge_chunks
  `;
  const existingByKey = new Map(existing.map((row) => [chunkKey(row.source_path, row.chunk_index), row]));
  const desiredByKey = new Map(chunks.map((chunk) => [chunkKey(chunk.sourcePath, chunk.chunkIndex), chunk]));

  const pending = chunks.filter((chunk) => {
    const previous = existingByKey.get(chunkKey(chunk.sourcePath, chunk.chunkIndex));
    return (
      !previous ||
      previous.content_hash !== chunk.contentHash ||
      previous.embedding_model !== settings.model
    );
  });
  const stale = [...existingByKey.entries()].filter(([key, row]) => {
    const desired = desiredByKey.get(key);
    return (
      !desired ||
      desired.contentHash !== row.content_hash ||
      row.embedding_model !== settings.model
    );
  });

  const vectors =
    pending.length === 0 ? [] : await embedTexts(pending.map((chunk) => embeddingInput(chunk)), settings);

  if (pending.length > 0 || stale.length > 0) {
    await sql.begin(async (tx) => {
      for (const [, row] of stale) {
        await tx`
          DELETE FROM knowledge_chunks
          WHERE source_path = ${row.source_path}
            AND chunk_index = ${row.chunk_index}
        `;
      }
      for (let index = 0; index < pending.length; index += 1) {
        const chunk = pending[index];
        const embedding = vectors[index];
        if (!embedding) {
          throw new Error("嵌入结果缺少向量");
        }
        await tx`
          INSERT INTO knowledge_chunks (
            source_path,
            doc_title,
            doc_type,
            heading_path,
            chunk_index,
            content,
            content_hash,
            embedding_model,
            sources,
            embedding
          ) VALUES (
            ${chunk.sourcePath},
            ${chunk.docTitle},
            ${chunk.docType},
            ${chunk.headingPath},
            ${chunk.chunkIndex},
            ${chunk.content},
            ${chunk.contentHash},
            ${settings.model},
            ${JSON.stringify(chunk.sources)}::jsonb,
            ${toVectorLiteral(embedding)}::vector
          )
        `;
      }
    });
  }

  const removed = stale.filter(([key]) => !desiredByKey.has(key));
  const pendingKeys = new Set(pending.map((chunk) => chunkKey(chunk.sourcePath, chunk.chunkIndex)));
  const changes: IndexChange[] = [
    ...chunks.map((chunk) => ({
      action: pendingKeys.has(chunkKey(chunk.sourcePath, chunk.chunkIndex))
        ? ("embed" as const)
        : ("skip" as const),
      sourcePath: chunk.sourcePath,
      chunkIndex: chunk.chunkIndex,
      headingPath: chunk.headingPath,
    })),
    ...removed.map(([, row]) => ({
      action: "delete" as const,
      sourcePath: row.source_path,
      chunkIndex: row.chunk_index,
      headingPath: row.heading_path,
    })),
  ];

  return {
    chunkCount: chunks.length,
    embeddedCount: pending.length,
    unchangedCount: chunks.length - pending.length,
    removedCount: removed.length,
    changes,
  };
}

function chunkKey(sourcePath: string, chunkIndex: number): string {
  return `${sourcePath}\0${chunkIndex}`;
}
