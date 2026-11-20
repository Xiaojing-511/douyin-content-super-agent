import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 灌库命令在 Next 之外运行，不会自动读 .env。
 * 已经存在于进程环境里的键保持不变。.env.local 覆盖 .env 里的同名键。
 */

export function loadLocalEnvFiles(directory = process.cwd()): void {
  const alreadySet = new Set(Object.keys(process.env));
  applyEnvFile(path.join(directory, ".env"), alreadySet);
  applyEnvFile(path.join(directory, ".env.local"), alreadySet);
}

function applyEnvFile(file: string, alreadySet: Set<string>): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!key || alreadySet.has(key)) {
      continue;
    }
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
