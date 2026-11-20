import "server-only";

import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

import { config } from "@/lib/config";
import { sanitizeExportTitle } from "@/lib/exports/marker";
import { exportFileId, resolveExportPdfPath } from "@/lib/exports/files";

interface PdfFont {
  file: string;
  family?: string;
}

export interface WrittenPdf {
  fileId: string;
  title: string;
  bytes: number;
}

/** 把已经写完的口播画进 PDF。同一内容重复调用会覆盖同一个文件。 */
export async function writeExportPdf(input: {
  title: string;
  markdown: string;
  signal: AbortSignal | undefined;
}): Promise<WrittenPdf> {
  if (input.signal?.aborted) {
    throw new DOMException("模型回复已取消", "AbortError");
  }
  const title = sanitizeExportTitle(input.title);
  const markdown = input.markdown.replace(/\r\n/g, "\n").trim();
  if (!markdown) {
    throw new Error("PDF 正文是空的");
  }
  const font = resolvePdfFont();
  const fileId = exportFileId(title, markdown);
  const finalPath = resolveExportPdfPath(config.exportRoot, config.fixedThreadId, fileId);
  const partialPath = `${finalPath}.partial`;
  await mkdir(path.dirname(finalPath), { recursive: true });

  try {
    await renderPdf({ partialPath, title, markdown, font, signal: input.signal });
    if (input.signal?.aborted) {
      throw new DOMException("模型回复已取消", "AbortError");
    }
    await rename(partialPath, finalPath);
  } catch (error: unknown) {
    await rm(partialPath, { force: true });
    throw error;
  }

  const info = await stat(finalPath);
  return { fileId, title, bytes: info.size };
}

function resolvePdfFont(): PdfFont {
  const candidates: PdfFont[] = [];
  if (config.pdfFontPath) {
    candidates.push({ file: config.pdfFontPath, family: config.pdfFontFamily || undefined });
  }
  candidates.push(
    { file: "/System/Library/Fonts/Supplemental/Songti.ttc", family: "STSongti-SC-Regular" },
    { file: "/System/Library/Fonts/Hiragino Sans GB.ttc", family: "HiraginoSansGB-W3" },
    { file: "/System/Library/Fonts/STHeiti Medium.ttc", family: "STHeitiSC-Medium" },
    { file: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "NotoSansCJK-Regular" },
    { file: "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", family: "NotoSansCJK-Regular" },
  );
  const found = candidates.find((candidate) => candidate.file && existsSync(candidate.file));
  if (!found) {
    throw new Error("没有找到可嵌入的中文字体。可在 .env 设置 PDF_FONT_PATH 和 PDF_FONT_FAMILY。");
  }
  return found;
}

function renderPdf(input: {
  partialPath: string;
  title: string;
  markdown: string;
  font: PdfFont;
  signal: AbortSignal | undefined;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 64,
      info: { Title: input.title },
    });
    const stream = createWriteStream(input.partialPath);
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      if (error) {
        doc.destroy();
        stream.destroy();
        reject(error);
        return;
      }
      resolve();
    };
    const onAbort = () => {
      finish(new DOMException("模型回复已取消", "AbortError"));
    };
    if (input.signal?.aborted) {
      finish(new DOMException("模型回复已取消", "AbortError"));
      return;
    }
    input.signal?.addEventListener("abort", onAbort);
    stream.on("error", finish);
    doc.on("error", finish);
    stream.on("finish", () => finish());
    doc.pipe(stream);
    try {
      if (input.font.family) {
        doc.font(input.font.file, input.font.family);
      } else {
        doc.font(input.font.file);
      }
      doc.fontSize(18).text(input.title);
      doc.moveDown();
      doc.fontSize(12).text(input.markdown, { lineGap: 6 });
      doc.end();
    } catch (error: unknown) {
      finish(error);
    }
  });
}
