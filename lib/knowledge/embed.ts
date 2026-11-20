import type { EmbeddingSettings } from "./settings";

/**
 * 调用 OpenAI 兼容的 /embeddings。
 * 对话模型和嵌入模型可以不是同一家，所以这里不复用 ChatOpenAI。
 */

const EMBEDDING_TIMEOUT_MS = 60_000;
const EMBEDDING_BATCH_SIZE = 16;

type EmbeddingResponse = {
  data?: { index?: number; embedding?: number[] }[];
};

export async function embedTexts(
  texts: string[],
  settings: EmbeddingSettings,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    vectors.push(...(await embedBatch(batch, settings, signal)));
  }
  return vectors;
}

export function toVectorLiteral(values: number[]): string {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("向量里有无效数字");
  }
  return `[${values.join(",")}]`;
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) {
    return text;
  }
  return text.split(secret).join("***");
}

async function embedBatch(
  texts: string[],
  settings: EmbeddingSettings,
  signal?: AbortSignal,
): Promise<number[][]> {
  const timeout = AbortSignal.timeout(EMBEDDING_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        input: texts,
      }),
      signal: requestSignal,
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "网络错误";
    throw new Error(`嵌入接口连不上：${redactSecret(message, settings.apiKey)}`);
  }

  if (!response.ok) {
    const detail = redactSecret(await response.text(), settings.apiKey).slice(0, 500);
    throw new Error(`嵌入接口返回 ${response.status}：${detail}`);
  }

  const payload = (await response.json()) as EmbeddingResponse;
  const rows = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  if (rows.length !== texts.length) {
    throw new Error(`嵌入接口返回了 ${rows.length} 条向量，请求了 ${texts.length} 条`);
  }

  return rows.map((row, index) => {
    const embedding = row.embedding;
    if (!embedding || embedding.length !== settings.dimensions) {
      throw new Error(
        `第 ${index + 1} 条向量维度是 ${embedding?.length ?? 0}，EMBEDDING_DIMENSIONS 是 ${settings.dimensions}。两者必须一致。`,
      );
    }
    if (embedding.some((value) => !Number.isFinite(value))) {
      throw new Error("嵌入结果含有无效数字");
    }
    return embedding;
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
