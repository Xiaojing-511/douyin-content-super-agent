/**
 * 嵌入配置在调用时读取，不在模块加载时定死。
 * 灌库命令会先把 .env 写进 process.env，再调用这里。
 * 对话进程由 Next 提前装好环境变量，同一组函数可以直接用。
 */

const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
};

export type RerankSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

const RERANK_SETTING_NAMES = ["RERANK_BASE_URL", "RERANK_API_KEY", "RERANK_MODEL"] as const;

export function readDatabaseUrl(): string {
  const configuredUrl =
    process.env.DATABASE_URL ?? "postgresql://advisor:advisor@localhost:5432/advisor";
  return configuredUrl.replace(/^postgres(ql)?\+asyncpg:\/\//, "postgresql://");
}

export function missingEmbeddingSettingNames(): string[] {
  const missing: string[] = [];
  if (!(process.env.EMBEDDING_BASE_URL ?? "").trim()) {
    missing.push("EMBEDDING_BASE_URL");
  }
  if (!(process.env.EMBEDDING_API_KEY ?? "").trim()) {
    missing.push("EMBEDDING_API_KEY");
  }
  if (!(process.env.EMBEDDING_MODEL ?? "").trim()) {
    missing.push("EMBEDDING_MODEL");
  }
  return missing;
}

export function readEmbeddingSettings(): EmbeddingSettings | null {
  if (missingEmbeddingSettingNames().length > 0) {
    return null;
  }

  const dimensions = readEmbeddingDimensions();
  return {
    baseUrl: (process.env.EMBEDDING_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    apiKey: (process.env.EMBEDDING_API_KEY ?? "").trim(),
    model: (process.env.EMBEDDING_MODEL ?? "").trim(),
    dimensions,
  };
}

/**
 * 三项都空着时返回 null，检索只按向量距离截断。
 * 只填了一部分时直接失败，避免带着半套地址去请求。
 */
export function readRerankSettings(): RerankSettings | null {
  const values = {
    RERANK_BASE_URL: (process.env.RERANK_BASE_URL ?? "").trim(),
    RERANK_API_KEY: (process.env.RERANK_API_KEY ?? "").trim(),
    RERANK_MODEL: (process.env.RERANK_MODEL ?? "").trim(),
  };
  const missing = RERANK_SETTING_NAMES.filter((name) => !values[name]);
  if (missing.length === RERANK_SETTING_NAMES.length) {
    return null;
  }
  if (missing.length > 0) {
    throw new Error(`重排配置不完整，还缺 ${missing.join("、")}`);
  }
  return {
    baseUrl: values.RERANK_BASE_URL.replace(/\/+$/, ""),
    apiKey: values.RERANK_API_KEY,
    model: values.RERANK_MODEL,
  };
}

function readEmbeddingDimensions(): number {
  const raw = (process.env.EMBEDDING_DIMENSIONS ?? "").trim();
  const dimensions = raw ? Number(raw) : DEFAULT_EMBEDDING_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    throw new Error("EMBEDDING_DIMENSIONS 必须是 1 到 8192 的整数");
  }
  return dimensions;
}
