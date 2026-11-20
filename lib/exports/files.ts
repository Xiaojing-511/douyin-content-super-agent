import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";

/** 同一段标题和正文得到同一个文件名，重复导出覆盖这一份。 */
export function exportFileId(title: string, markdown: string): string {
  return createHash("sha256").update(title).update("\n").update(markdown).digest("hex").slice(0, 16);
}

/**
 * 只允许写到导出根目录下、当前会话子目录里的 16 位哈希 PDF。
 * 文件名来自内容哈希，不接受模型或浏览器传入的路径。
 */
export function resolveExportPdfPath(root: string, threadId: string, fileId: string): string {
  if (!/^[a-f0-9]{16}$/.test(fileId)) {
    throw new Error("导出文件名无效");
  }
  const safeThread = threadId.replace(/[^a-zA-Z0-9_-]/g, "") || "session";
  const directory = path.resolve(root, safeThread);
  const target = path.resolve(directory, `${fileId}.pdf`);
  const relative = path.relative(directory, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("导出路径越界");
  }
  return target;
}
