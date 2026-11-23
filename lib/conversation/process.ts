import type { ProcessStep, ProcessStepState } from "@/lib/conversation/types";

/**
 * 助手气泡上方的过程条。
 *
 * 生成时可以有 running，包括只在当轮出现的「正在写口播」。
 * 写入 process 列之前先去掉这一步，并把还在进行的步骤收成 stopped。
 * 下一轮提示只读 content，不读这里。
 */

export const WRITE_STEP_ID = "write";

const STEP_STATES = new Set<ProcessStepState>(["running", "done", "failed", "stopped"]);
const STORED_STATES = new Set<ProcessStepState>(["done", "failed", "stopped"]);

export function upsertProcessStep(steps: ProcessStep[], step: ProcessStep): ProcessStep[] {
  const index = steps.findIndex((item) => item.id === step.id);
  if (index < 0) {
    return [...steps, step];
  }
  const next = steps.slice();
  next[index] = step;
  return next;
}

export function writeStep(): ProcessStep {
  return {
    id: WRITE_STEP_ID,
    state: "running",
    title: "正在写口播",
    detail: "",
  };
}

export function stepFromTool(tool: { id: string; phase: string; name: string; detail: string }): ProcessStep {
  const id = tool.id || tool.name || "tool";
  if (tool.phase === "call") {
    return {
      id,
      state: "running",
      title: runningTitle(tool.name),
      detail: tool.name === "web_search" ? tool.detail : "",
    };
  }
  return {
    id,
    state: tool.phase === "error" ? "failed" : "done",
    title: finishedTitle(tool.name),
    detail: tool.detail,
  };
}

/** 数据库和刷新后的历史只接受已经结束的步骤。 */
export function parseProcess(value: unknown): ProcessStep[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const steps: ProcessStep[] = [];
  for (const item of value) {
    const step = parseProcessStep(item);
    if (!step || step.id === WRITE_STEP_ID || !STORED_STATES.has(step.state)) {
      continue;
    }
    steps.push(step);
  }
  return steps.length > 0 ? steps : null;
}

export function parseProcessStep(value: unknown): ProcessStep | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as { id?: unknown; state?: unknown; title?: unknown; detail?: unknown };
  if (typeof record.id !== "string" || record.id.length === 0 || typeof record.title !== "string") {
    return null;
  }
  if (!STEP_STATES.has(record.state as ProcessStepState)) {
    return null;
  }
  return {
    id: record.id,
    state: record.state as ProcessStepState,
    title: record.title,
    detail: typeof record.detail === "string" ? record.detail : "",
  };
}

/** 落库快照。进行中的步骤在用户停止时写成已停止，否则收成完成。 */
export function processToStore(steps: ProcessStep[], stopped: boolean): ProcessStep[] | null {
  const stored: ProcessStep[] = [];
  for (const step of steps) {
    if (step.id === WRITE_STEP_ID) {
      continue;
    }
    if (step.state !== "running") {
      stored.push(step);
      continue;
    }
    stored.push({
      id: step.id,
      state: stopped ? "stopped" : "done",
      title: settleRunningTitle(step.title),
      detail: stopped ? "已停止" : step.detail,
    });
  }
  return stored.length > 0 ? stored : null;
}

export function hasVisibleProcess(steps: ProcessStep[] | undefined): boolean {
  return (steps ?? []).some((step) => step.id !== WRITE_STEP_ID);
}

/** 收起后的一行。不含「正在写口播」。 */
export function processSummary(steps: ProcessStep[]): string {
  const settled = steps.filter((step) => step.id !== WRITE_STEP_ID && step.state !== "running");
  const parts: string[] = [];
  const knowledge = settled.find((step) => step.id === "knowledge");
  if (knowledge?.state === "done") {
    parts.push("查阅了知识库");
  } else if (knowledge?.state === "failed") {
    parts.push("知识库没有完成");
  } else if (knowledge?.state === "stopped") {
    parts.push("查阅已停止");
  }

  const searches = settled.filter((step) => step.title === "联网搜索");
  if (searches.length > 0) {
    parts.push(`联网搜索 ${searches.length} 次`);
    if (searches.some((step) => step.state === "failed")) {
      parts.push("搜索未返回结果");
    }
  }

  const pdfs = settled.filter((step) => step.title === "生成 PDF");
  if (pdfs.some((step) => step.state === "done")) {
    parts.push("已生成 PDF");
  } else if (pdfs.some((step) => step.state === "failed")) {
    parts.push("PDF 没有生成");
  }

  if (settled.some((step) => step.id === "limit")) {
    parts.push("改为直接写口播");
  }
  return parts.join(" · ");
}

export function processHeadline(steps: ProcessStep[], live: boolean): string {
  const summary = processSummary(steps);
  if (!live) {
    return summary;
  }
  const running = [...steps].reverse().find((step) => step.state === "running");
  if (running && summary) {
    return `${summary} · ${running.title}`;
  }
  if (running) {
    return running.title;
  }
  return summary || "正在处理";
}

function runningTitle(name: string): string {
  if (name === "web_search") {
    return "正在联网搜索";
  }
  if (name === "export_pdf") {
    return "正在生成 PDF";
  }
  return "正在调用工具";
}

function finishedTitle(name: string): string {
  if (name === "web_search") {
    return "联网搜索";
  }
  if (name === "export_pdf") {
    return "生成 PDF";
  }
  return "调用工具";
}

function settleRunningTitle(title: string): string {
  if (title === "正在联网搜索") {
    return "联网搜索";
  }
  if (title === "正在生成 PDF") {
    return "生成 PDF";
  }
  if (title === "正在调用工具") {
    return "调用工具";
  }
  return title;
}
