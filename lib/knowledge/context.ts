import type { KnowledgeSource } from "@/lib/knowledge/chunk-markdown";

/**
 * 召回结果只在这一轮拼进系统提示，不写进消息表，也不进图的 messages。
 * 短追问单独嵌入会丢上文，所以检索问句会带上一条用户原话。
 */

const SHORT_QUERY_CHARACTERS = 20;

export type RetrievedChunk = {
  docTitle: string;
  docType: string;
  headingPath: string;
  content: string;
  sources: KnowledgeSource[];
  distance: number;
  rerankScore?: number;
};

export function buildSearchQuery(userTexts: readonly string[]): string {
  const current = userTexts.at(-1)?.trim() ?? "";
  if (!current) {
    return "";
  }
  const previous = userTexts.at(-2)?.trim();
  if (previous && Array.from(current).length <= SHORT_QUERY_CHARACTERS) {
    return `上一句：${previous}\n这一句：${current}`;
  }
  return current;
}

export function renderKnowledgeContext(chunks: readonly RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "";
  }

  const blocks = [
    "下面是本轮从知识库召回的资料。组织回答时优先使用这些资料。用到某一段时，写出它的文档标题。资料没有覆盖的内容，不要说成资料里的结论。",
  ];
  chunks.forEach((chunk, index) => {
    blocks.push(`资料 ${index + 1}｜${chunk.docType}｜${chunk.headingPath}\n${chunk.content}`);
  });

  const seen = new Set<string>();
  const sourceLines: string[] = [];
  for (const chunk of chunks) {
    for (const source of chunk.sources) {
      const key = `${chunk.docTitle}\0${source.url}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      sourceLines.push(`- ${chunk.docTitle}：${source.title} ${source.url}`);
    }
  }
  if (sourceLines.length > 0) {
    blocks.push(`这些资料的出处：\n${sourceLines.join("\n")}`);
  }
  return blocks.join("\n\n");
}
