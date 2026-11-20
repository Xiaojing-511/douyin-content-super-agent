/** 导出文件在助手正文末尾的标记。页面把它显示成下载链接，不把这一行当口播。 */

import type { ExportLink } from "@/lib/conversation/types";

export type { ExportLink };

const EXPORT_LINE = /^导出文件：([^｜\n]+)｜([a-f0-9]{16})$/;

export function sanitizeExportTitle(title: string): string {
  const cleaned = title.replace(/[｜\r\n]/g, " ").replace(/\s+/g, " ").trim();
  const shortened = Array.from(cleaned).slice(0, 40).join("");
  return shortened || "口播";
}

export function exportMarkerLine(file: ExportLink): string {
  return `\n\n导出文件：${sanitizeExportTitle(file.title)}｜${file.fileId}`;
}

export function splitExportMarkers(content: string): { body: string; files: ExportLink[] } {
  const files: ExportLink[] = [];
  const bodyLines: string[] = [];
  for (const line of content.split("\n")) {
    const matched = EXPORT_LINE.exec(line);
    if (matched?.[1] && matched[2]) {
      files.push({ title: matched[1], fileId: matched[2] });
      continue;
    }
    bodyLines.push(line);
  }
  return {
    body: bodyLines.join("\n").replace(/^\n+|\n+$/g, ""),
    files,
  };
}

export function dedupeExportLinks(files: ExportLink[]): ExportLink[] {
  const seen = new Set<string>();
  const unique: ExportLink[] = [];
  for (const file of files) {
    if (seen.has(file.fileId)) {
      continue;
    }
    seen.add(file.fileId);
    unique.push(file);
  }
  return unique;
}
