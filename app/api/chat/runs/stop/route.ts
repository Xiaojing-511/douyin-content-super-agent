import { stopActiveChatRun } from "@/lib/conversation/active-run";
import { readVisitorId } from "@/lib/conversation/visitor";
import { logInfo } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 停下这个浏览器当前这一轮生成。写库发生在原来的生成接口里，写完后它会发出 done。 */
export async function POST(request: Request) {
  const threadId = readVisitorId(request);
  const stopped = threadId ? stopActiveChatRun(threadId) : false;
  logInfo("收到停止生成请求", {
    会话: threadId ?? "无",
    已对上当前轮次: stopped,
  });
  return Response.json({ stopped });
}
