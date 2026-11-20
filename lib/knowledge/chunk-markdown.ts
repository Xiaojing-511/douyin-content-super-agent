import { createHash } from "node:crypto";

/**
 * 按 Markdown 标题把一篇文档切成检索片段。
 * 一个 ## 或 ### 节就是一块。只有一两句导语的标题不单独成块。
 * 超过字数上限时才按段落再切，并保留一小段重叠。
 * 「参考来源」「证据说明」不参与相似度检索，来源链接记在片段的 sources 上。
 */

const MAX_CHUNK_CHARACTERS = 800;
const CHUNK_OVERLAP_CHARACTERS = 80;
const MIN_CHUNK_CHARACTERS = 20;

export type KnowledgeSource = {
  title: string;
  url: string;
};

export type KnowledgeChunkDraft = {
  sourcePath: string;
  docTitle: string;
  docType: string;
  headingPath: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  sources: KnowledgeSource[];
};

type SectionKind = "body" | "sources" | "skip";

type Section = {
  headingPath: string;
  title: string;
  kind: SectionKind;
  body: string;
};

export function chunkMarkdownDocument(input: {
  sourcePath: string;
  markdown: string;
}): KnowledgeChunkDraft[] {
  const markdown = input.markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const { meta, body } = splitFrontmatter(markdown);
  const docType = meta.docType?.trim() ?? "";
  if (!docType) {
    throw new Error(`${input.sourcePath} 缺少头信息 docType`);
  }

  const sections = parseSections(body);
  const docTitle = meta.title?.trim() || firstHeading(sections) || input.sourcePath;
  const sources = sections
    .filter((section) => section.kind === "sources")
    .flatMap((section) => parseSources(section.body));

  const drafts: KnowledgeChunkDraft[] = [];
  for (const section of sections) {
    if (section.kind !== "body") {
      continue;
    }
    const headingPath = section.headingPath ? `${docTitle} / ${section.headingPath}` : docTitle;
    const cleaned = stripEvidenceNote(section.body);
    if (!cleaned) {
      continue;
    }
    for (const piece of splitLongText(cleaned)) {
      const content = piece.trim();
      if (characterCount(content) < MIN_CHUNK_CHARACTERS) {
        continue;
      }
      drafts.push({
        sourcePath: input.sourcePath,
        docTitle,
        docType,
        headingPath,
        chunkIndex: drafts.length,
        content,
        contentHash: hashChunk({ docType, headingPath, content, sources }),
        sources,
      });
    }
  }

  return drafts;
}

export function embeddingInput(chunk: Pick<KnowledgeChunkDraft, "docType" | "headingPath" | "content">): string {
  return `类型：${chunk.docType}\n${chunk.headingPath}\n${chunk.content}`;
}

function hashChunk(parts: {
  docType: string;
  headingPath: string;
  content: string;
  sources: KnowledgeSource[];
}): string {
  return createHash("sha256")
    .update(`${parts.docType}\n${parts.headingPath}\n${parts.content}\n${JSON.stringify(parts.sources)}`)
    .digest("hex");
}

function splitFrontmatter(markdown: string): { meta: Record<string, string>; body: string } {
  if (!markdown.startsWith("---\n")) {
    return { meta: {}, body: markdown };
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) {
    return { meta: {}, body: markdown };
  }

  const meta: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      meta[key] = value;
    }
  }
  return { meta, body: markdown.slice(end + "\n---\n".length) };
}

function parseSections(body: string): Section[] {
  const lines = body.split("\n");
  const stack: { level: number; title: string }[] = [];
  const sections: Section[] = [];
  let buffer: string[] = [];
  let currentPath = "";
  let currentTitle = "";
  let currentKind: SectionKind = "body";
  let skipLevel: number | null = null;

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text || !currentTitle) {
      return;
    }
    sections.push({
      headingPath: currentPath,
      title: currentTitle,
      kind: currentKind,
      body: text,
    });
  };

  for (const line of lines) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      buffer.push(line);
      continue;
    }

    flush();
    const level = match[1].length;
    const title = match[2].replace(/\s+#+\s*$/, "").trim();
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    if (skipLevel !== null && level <= skipLevel) {
      skipLevel = null;
    }
    stack.push({ level, title });

    const kind = skipLevel !== null && level > skipLevel ? "skip" : sectionKind(title);
    if (kind !== "body" && (skipLevel === null || level < skipLevel)) {
      skipLevel = level;
    }

    currentTitle = title;
    currentKind = kind;
    currentPath = stack
      .filter((item) => item.level > 1)
      .map((item) => item.title)
      .join(" / ");
  }

  flush();
  return sections;
}

function sectionKind(title: string): SectionKind {
  const normalized = title.replace(/^[一二三四五六七八九十0-9]+[、.．]\s*/, "").trim();
  if (normalized === "参考来源") {
    return "sources";
  }
  if (normalized === "证据说明") {
    return "skip";
  }
  return "body";
}

function parseSources(body: string): KnowledgeSource[] {
  const sources: KnowledgeSource[] = [];
  for (const line of body.split("\n")) {
    if (line.trim().startsWith("**证据说明")) {
      continue;
    }
    const urlMatch = /https?:\/\/[^\s)]+/.exec(line);
    if (!urlMatch) {
      continue;
    }
    const url = urlMatch[0].replace(/[.,，。]+$/, "");
    const title = line
      .replace(/^\s*\d+[、.．]\s*/, "")
      .replace(urlMatch[0], "")
      .replace(/\*+/g, "")
      .replace(/[：:.\s]+$/g, "")
      .trim();
    sources.push({ title: title || url, url });
  }
  return sources;
}

function stripEvidenceNote(body: string): string {
  return body
    .split("\n")
    .filter((line) => !line.trim().startsWith("**证据说明"))
    .join("\n")
    .trim();
}

function splitLongText(body: string): string[] {
  if (characterCount(body) <= MAX_CHUNK_CHARACTERS) {
    return [body];
  }

  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  const pushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    const text = current.join("\n\n").trim();
    if (text) {
      chunks.push(text);
    }
    const overlap = tailCharacters(text, CHUNK_OVERLAP_CHARACTERS);
    current = overlap ? [overlap] : [];
  };

  for (const paragraph of paragraphs) {
    if (characterCount(paragraph) > MAX_CHUNK_CHARACTERS) {
      pushCurrent();
      current = [];
      for (const piece of hardSplit(paragraph)) {
        chunks.push(piece);
      }
      const overlap = tailCharacters(chunks[chunks.length - 1] ?? "", CHUNK_OVERLAP_CHARACTERS);
      current = overlap ? [overlap] : [];
      continue;
    }

    const next = [...current, paragraph].join("\n\n");
    if (current.length > 0 && characterCount(next) > MAX_CHUNK_CHARACTERS) {
      pushCurrent();
    }
    current.push(paragraph);
  }

  const tail = current.join("\n\n").trim();
  if (tail && !isOverlapLeftover(tail, chunks[chunks.length - 1])) {
    chunks.push(tail);
  }
  return chunks;
}

function hardSplit(paragraph: string): string[] {
  const characters = Array.from(paragraph);
  const step = MAX_CHUNK_CHARACTERS - CHUNK_OVERLAP_CHARACTERS;
  const pieces: string[] = [];
  for (let start = 0; start < characters.length; start += step) {
    pieces.push(characters.slice(start, start + MAX_CHUNK_CHARACTERS).join(""));
    if (start + MAX_CHUNK_CHARACTERS >= characters.length) {
      break;
    }
  }
  return pieces;
}

function isOverlapLeftover(text: string, previous: string | undefined): boolean {
  if (!previous) {
    return false;
  }
  return previous.endsWith(text) && characterCount(text) <= CHUNK_OVERLAP_CHARACTERS;
}

function tailCharacters(text: string, count: number): string {
  const characters = Array.from(text);
  if (characters.length === 0) {
    return "";
  }
  if (characters.length <= count) {
    return text;
  }
  return characters.slice(characters.length - count).join("");
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

function firstHeading(sections: Section[]): string {
  return sections.find((section) => section.title)?.title ?? "";
}
