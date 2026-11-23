import { readFile } from "node:fs/promises";

import { config } from "@/lib/config";
import { resolveExportPdfPath } from "@/lib/exports/files";
import { readVisitorId } from "@/lib/conversation/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只提供这张浏览器票对应目录里、文件名是内容哈希的 PDF。 */
export async function GET(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const threadId = readVisitorId(request);
  if (!threadId) {
    return new Response("找不到这个文件", { status: 404 });
  }

  const { fileId } = await context.params;
  let filePath: string;
  try {
    filePath = resolveExportPdfPath(config.exportRoot, threadId, fileId);
  } catch {
    return new Response("找不到这个文件", { status: 404 });
  }

  try {
    const bytes = await readFile(filePath);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileId}.pdf"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("找不到这个文件", { status: 404 });
  }
}
