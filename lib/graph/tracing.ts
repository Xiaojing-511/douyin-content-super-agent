import "server-only";

import type { RunnableConfig } from "@langchain/core/runnables";
import type { RunnableConfigLike } from "langsmith/run_trees";

import { config } from "@/lib/config";

/**
 * 嵌入和重排是直接 fetch，不会自动出现在图的追踪里。
 * 追踪打开时，把当前节点的 config 当作 traceable 的第一个参数。
 * LangSmith 从里面的 langchain_tracer 找到这一节点的 run，新步骤记成它的子 run。
 * 追踪关闭时不能把 config 传进去，否则第一个参数会被当成函数输入。
 */

type TracedCall<Input extends Record<string, unknown>, Result> = (
  input: Input,
) => Result | Promise<Result>;

export function invokeTraced<Input extends Record<string, unknown>, Result>(
  runConfig: RunnableConfig | undefined,
  traced: TracedCall<Input, Result>,
  input: Input,
): Promise<Result> {
  if (!hasLangSmithTracer(runConfig)) {
    return Promise.resolve(traced(input));
  }
  const withParent = traced as unknown as (
    config: RunnableConfigLike,
    value: Input,
  ) => Promise<Result>;
  return withParent(runConfig as RunnableConfigLike, input);
}

function hasLangSmithTracer(runConfig: RunnableConfig | undefined): boolean {
  if (!config.langsmithTracing || !config.langsmithApiKey) {
    return false;
  }
  const callbacks = runConfig?.callbacks;
  if (callbacks == null || typeof callbacks !== "object") {
    return false;
  }
  const handlers = Array.isArray(callbacks)
    ? callbacks
    : "handlers" in callbacks && Array.isArray(callbacks.handlers)
      ? callbacks.handlers
      : [];
  return handlers.some(
    (handler) =>
      typeof handler === "object" &&
      handler !== null &&
      "name" in handler &&
      (handler as { name?: unknown }).name === "langchain_tracer",
  );
}
