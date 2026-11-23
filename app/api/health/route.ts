import { pingDatabase } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let databaseStatus: "ok" | "unavailable" = "ok";
  try {
    await pingDatabase();
  } catch (error: unknown) {
    databaseStatus = "unavailable";
    logError("健康检查时数据库不可用", {
      原因: error instanceof Error ? error.message : "未知错误",
    });
  }

  const overallStatus = databaseStatus === "ok" ? "ok" : "degraded";
  logInfo("健康检查完成", {
    状态: overallStatus,
    数据库: databaseStatus,
  });

  return Response.json({
    status: overallStatus,
    database: databaseStatus,
  });
}
