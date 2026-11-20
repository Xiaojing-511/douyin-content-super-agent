import { redactSecret } from "./embed";
import type { RerankSettings } from "./settings";

/**
 * 调用 Cohere / SiliconFlow 这一类的 /rerank。
 * 请求体是 query、documents、top_n。返回的 index 指回 documents 的位置。
 * 模型名由调用方传入，这里不假定具体模型。
 */

const RERANK_TIMEOUT_MS = 30_000;

export type RerankHit = {
  index: number;
  score: number;
};

type RerankResponse = {
  results?: { index?: number; relevance_score?: number }[];
};

export async function rerankTexts(
  query: string,
  documents: string[],
  settings: RerankSettings,
  topN: number,
  signal?: AbortSignal,
): Promise<RerankHit[]> {
  if (documents.length === 0) {
    return [];
  }
  const limit = Math.min(topN, documents.length);
  if (limit < 1) {
    throw new Error("重排条数必须大于 0");
  }

  const timeout = AbortSignal.timeout(RERANK_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl}/rerank`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        query,
        documents,
        top_n: limit,
        return_documents: false,
      }),
      signal: requestSignal,
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "网络错误";
    throw new Error(`重排接口连不上：${redactSecret(message, settings.apiKey)}`);
  }

  if (!response.ok) {
    const detail = redactSecret(await response.text(), settings.apiKey).slice(0, 500);
    throw new Error(`重排接口返回 ${response.status}：${detail}`);
  }

  const payload = (await response.json()) as RerankResponse;
  return readHits(payload.results ?? [], documents.length, limit);
}

function readHits(rows: { index?: number; relevance_score?: number }[], documentCount: number, limit: number): RerankHit[] {
  if (rows.length !== limit) {
    throw new Error(`重排接口返回了 ${rows.length} 条，请求的是前 ${limit} 条`);
  }

  const seen = new Set<number>();
  const hits = rows.map((row, position) => {
    const index = row.index;
    const score = row.relevance_score;
    if (!Number.isInteger(index) || index === undefined || index < 0 || index >= documentCount) {
      throw new Error(`重排结果第 ${position + 1} 条的 index 无效`);
    }
    if (seen.has(index)) {
      throw new Error("重排结果里有重复的 index");
    }
    seen.add(index);
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error(`重排结果第 ${position + 1} 条没有 relevance_score`);
    }
    return { index, score };
  });

  hits.sort((left, right) => right.score - left.score || left.index - right.index);
  return hits;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
