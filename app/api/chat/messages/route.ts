import { config } from "@/lib/config";
import { ensureConversationSchema } from "@/lib/db/client";
import { listMessages } from "@/lib/conversation/repository";
import { logError, logInfo } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 打开页面时读取已保存的历史。 */
export async function GET() {
  logInfo("收到读取历史请求");
  try {
    await ensureConversationSchema();
    const messages = await listMessages();
    return Response.json({
      threadId: config.fixedThreadId,
      messages,
    });
  } catch (error: unknown) {
    logError("读取历史失败", {
      原因: error instanceof Error ? error.message : "未知错误",
    });
    return Response.json({ detail: "暂时读不到已保存的对话" }, { status: 503 });
  }
}
