import { ensureConversationSchema } from "@/lib/db/client";
import { listMessages } from "@/lib/conversation/repository";
import { openVisitor, withVisitorCookie } from "@/lib/conversation/visitor";
import { logError, logInfo } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 打开页面时读取这个浏览器已保存的历史。没有票时签发一张。 */
export async function GET(request: Request) {
  const visitor = openVisitor(request);
  logInfo("收到读取历史请求", { 会话: visitor.threadId });
  try {
    await ensureConversationSchema();
    const messages = await listMessages(visitor.threadId);
    return withVisitorCookie(Response.json({ messages }), visitor);
  } catch (error: unknown) {
    logError("读取历史失败", {
      会话: visitor.threadId,
      原因: error instanceof Error ? error.message : "未知错误",
    });
    return withVisitorCookie(Response.json({ detail: "暂时读不到已保存的对话" }, { status: 503 }), visitor);
  }
}
