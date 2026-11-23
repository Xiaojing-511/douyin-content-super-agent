import "server-only";

/**
 * 每个访客最多一轮正在生成的回复。
 * 「停止生成」不直接断开页面上的 POST，而是调用这个把手。
 * 原来的响应流还开着，服务端写完已展示的半截回复后，仍能发出 done。
 * 放在 globalThis 上，开发模式热更新后，停止接口和生成接口仍看到同一个对象。
 * 这张表只在当前这一个进程里有效。
 */

const globalForActiveRun = globalThis as unknown as {
  activeChatRuns?: Map<string, () => void>;
};

function activeChatRuns(): Map<string, () => void> {
  if (!globalForActiveRun.activeChatRuns) {
    globalForActiveRun.activeChatRuns = new Map();
  }
  return globalForActiveRun.activeChatRuns;
}

/** 这个访客已经有一轮在生成时返回 false，不覆盖原来的停止把手。 */
export function beginActiveChatRun(threadId: string, stop: () => void): boolean {
  const runs = activeChatRuns();
  if (runs.has(threadId)) {
    return false;
  }
  runs.set(threadId, stop);
  return true;
}

export function endActiveChatRun(threadId: string, stop: () => void): void {
  const runs = activeChatRuns();
  if (runs.get(threadId) === stop) {
    runs.delete(threadId);
  }
}

export function stopActiveChatRun(threadId: string): boolean {
  const stop = activeChatRuns().get(threadId);
  if (!stop) {
    return false;
  }
  stop();
  return true;
}
