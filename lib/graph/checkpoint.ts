import "server-only";

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { config } from "@/lib/config";
import { logInfo } from "@/lib/logging";

/**
 * LangGraph 的 checkpoint 使用自己的 pg 连接池，和 Drizzle 的 postgres 客户端分开。
 * 两者连的是同一个库。表由 setup() 创建，不放进 Drizzle schema。
 * 连接池挂在 globalThis 上，避免开发态热更新反复打开新池。
 */

const globalForCheckpoint = globalThis as unknown as {
  advisorCheckpointerReady?: Promise<PostgresSaver>;
};

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!globalForCheckpoint.advisorCheckpointerReady) {
    const databaseUrl = config.databaseUrl;
    globalForCheckpoint.advisorCheckpointerReady = createCheckpointer(databaseUrl).catch(
      (error: unknown) => {
        globalForCheckpoint.advisorCheckpointerReady = undefined;
        throw error;
      },
    );
  }
  return globalForCheckpoint.advisorCheckpointerReady;
}

async function createCheckpointer(databaseUrl: string): Promise<PostgresSaver> {
  const checkpointer = PostgresSaver.fromConnString(databaseUrl);
  await checkpointer.setup();
  logInfo("检查点表已就绪");
  return checkpointer;
}
