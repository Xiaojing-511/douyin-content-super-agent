/**
 * 浏览器控制台里的中文流程日志。
 *
 * 发送、历史、停止和 trace 会带上这一步的内容。
 * 模型增量不逐段打印，否则一段回复会刷出很多行。开头和收尾在页面状态里记。
 */

function write(level: "info" | "error", message: string, details?: unknown): void {
  const line = `[顾问] ${message}`;
  if (details !== undefined) {
    console[level](line, details);
    return;
  }
  console[level](line);
}

export const clientLogger = {
  info(message: string, details?: unknown): void {
    write("info", message, details);
  },
  error(message: string, details?: unknown): void {
    write("error", message, details);
  },
};
