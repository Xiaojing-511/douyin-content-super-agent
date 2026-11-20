import { config } from "@/lib/config";
import { stopActiveChatRun } from "@/lib/conversation/active-run";
import { logInfo } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 停下当前这一轮生成。写库发生在原来的生成接口里，写完后它会发出 done。 */
export async function POST() {
  const stopped = stopActiveChatRun(config.fixedThreadId);
  logInfo("收到停止生成请求", {
    会话: config.fixedThreadId,
    已对上当前轮次: stopped,
  });
  return Response.json({ stopped });
}
