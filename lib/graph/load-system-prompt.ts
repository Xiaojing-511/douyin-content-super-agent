import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 系统提示放在仓库的 prompt 目录，方便直接打开修改。
 * 每次回复都重新读文件，所以保存后下一轮就会用新内容，不必重启进程。
 * 文件开头的 HTML 注释只给改提示的人看，不会发给模型。
 */

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), "prompt", "advisor-system.md");

export function loadAdvisorSystemPrompt(): string {
  const fileText = readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  const prompt = fileText.replace(/^\uFEFF?\s*<!--[\s\S]*?-->\s*/, "").trim();
  if (!prompt) {
    throw new Error("prompt/advisor-system.md 是空的");
  }
  return prompt;
}
