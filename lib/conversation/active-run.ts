import "server-only";

/**
 * 当前这一轮生成的停止把手。
 * 「停止生成」不直接断开页面上的 POST，而是调用这个把手。
 * 原来的响应流还开着，服务端写完已展示的半截回复后，仍能发出 done。
 * 放在 globalThis 上，开发模式热更新后，停止接口和生成接口仍看到同一个对象。
 */

interface ActiveChatRun {
  threadId: string;
  stop: () => void;
}

const globalForActiveRun = globalThis as unknown as {
  activeChatRun?: ActiveChatRun | null;
};

export function beginActiveChatRun(threadId: string, stop: () => void): void {
  globalForActiveRun.activeChatRun = { threadId, stop };
}

export function endActiveChatRun(stop: () => void): void {
  if (globalForActiveRun.activeChatRun?.stop === stop) {
    globalForActiveRun.activeChatRun = null;
  }
}

export function stopActiveChatRun(threadId: string): boolean {
  const activeRun = globalForActiveRun.activeChatRun;
  if (!activeRun || activeRun.threadId !== threadId) {
    return false;
  }
  activeRun.stop();
  return true;
}
